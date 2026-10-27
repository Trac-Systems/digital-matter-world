// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBurnableTap {
    function burn(uint256 amount) external;
}

/// @notice Immutable TAP custody with a payer-fixed split and permissionless expiry refunds.
contract DmwEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_EXPIRY = 1 hours;
    uint256 public constant MAX_EXPIRY = 30 days;
    uint256 public constant ROTATION_DELAY = 3 days;

    bytes32 public constant SPLIT_TYPEHASH = keccak256(
        "Split(address treasury,uint256 treasuryAmount,address finder,uint256 finderAmount,address landowner,uint256 landownerAmount,address discoverer,uint256 discovererAmount,uint256 burnAmount)"
    );
    bytes32 public constant RELEASE_TYPEHASH = keccak256(
        "Release(bytes32 requestId,address payer,uint256 amount,bytes32 splitHash,uint256 expiry,uint256 committeeEpoch)"
    );
    bytes32 public constant ROTATION_TYPEHASH =
        keccak256("RotateCommittee(address newCommittee,uint256 nonce,uint256 committeeEpoch,uint256 deadline)");

    enum Status {
        Unused,
        Open,
        Released,
        Refunded
    }

    struct Split {
        address treasury;
        uint256 treasuryAmount;
        address finder;
        uint256 finderAmount;
        address landowner;
        uint256 landownerAmount;
        address discoverer;
        uint256 discovererAmount;
        uint256 burnAmount;
    }

    struct Deposit {
        address payer;
        Status status;
        uint256 amount;
        uint256 expiry;
        bytes32 splitHash;
        Split split;
    }

    struct CommitteeProposal {
        address successor;
        uint256 executableAt;
        uint256 nonce;
        bool adminOrigin;
    }

    struct AdminProposal {
        address successor;
        uint256 executableAt;
    }

    IERC20 public immutable token;
    address public committee;
    address public admin;
    uint256 public committeeEpoch;
    uint256 public rotationNonce;
    uint256 public totalOpen;
    CommitteeProposal public pendingCommittee;
    AdminProposal public pendingAdmin;
    mapping(address => mapping(bytes32 => Deposit)) private _deposits;

    error InvalidAddress();
    error InvalidRequest();
    error InvalidAmount();
    error InvalidSplit();
    error InvalidExpiry();
    error InexactTransfer();
    error NotOpen();
    error ReleaseExpired();
    error RefundTooEarly();
    error InvalidSigner();
    error SignatureExpired();
    error Unauthorized();
    error NoProposal();
    error DelayNotElapsed();
    error AdminRecoveryPending();

    event Deposited(
        bytes32 indexed requestId, address indexed payer, uint256 amount, uint256 expiry, bytes32 splitHash, Split split
    );
    event Released(
        bytes32 indexed requestId,
        address indexed payer,
        address indexed relayer,
        bytes32 splitHash,
        uint256 amount,
        address committee,
        uint256 committeeEpoch
    );
    event Refunded(bytes32 indexed requestId, address indexed payer, address indexed relayer, uint256 amount);
    event CommitteeRotationScheduled(
        address indexed currentCommittee,
        address indexed successor,
        address indexed authority,
        uint256 executableAt,
        uint256 nonce,
        uint256 committeeEpoch,
        bool adminOrigin
    );
    event CommitteeRotationCancelled(address indexed successor, uint256 nonce);
    event CommitteeRotated(address indexed previous, address indexed current, uint256 committeeEpoch, uint256 nonce);
    event AdminTransferScheduled(address indexed current, address indexed successor, uint256 executableAt);
    event AdminTransferred(address indexed previous, address indexed current);

    constructor(address tap, address initialCommittee, address initialAdmin) EIP712("DmwEscrow", "1") {
        if (tap.code.length == 0) revert InvalidAddress();
        _validateAuthority(initialCommittee);
        _validateAuthority(initialAdmin);
        token = IERC20(tap);
        committee = initialCommittee;
        admin = initialAdmin;
        emit CommitteeRotated(address(0), initialCommittee, 0, 0);
        emit AdminTransferred(address(0), initialAdmin);
    }

    /// @notice A request ID is single-use for its payer in this deployment, including after settlement.
    function deposit(bytes32 requestId, uint256 amount, Split calldata split, uint256 expiry) external nonReentrant {
        if (requestId == bytes32(0) || _deposits[msg.sender][requestId].status != Status.Unused) {
            revert InvalidRequest();
        }
        if (amount == 0) revert InvalidAmount();
        if (expiry < block.timestamp + MIN_EXPIRY || expiry > block.timestamp + MAX_EXPIRY) revert InvalidExpiry();
        _validateRecipient(split.treasury, split.treasuryAmount);
        _validateRecipient(split.finder, split.finderAmount);
        _validateRecipient(split.landowner, split.landownerAmount);
        _validateRecipient(split.discoverer, split.discovererAmount);
        if (split.treasuryAmount + split.finderAmount + split.landownerAmount + split.discovererAmount + split.burnAmount != amount) {
            revert InvalidSplit();
        }

        bytes32 splitHash = hashSplit(split);
        _deposits[msg.sender][requestId] = Deposit(msg.sender, Status.Open, amount, expiry, splitHash, split);
        totalOpen += amount;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert InexactTransfer();
        emit Deposited(requestId, msg.sender, amount, expiry, splitHash, split);
    }

    /// @notice Anyone may relay a current committee signature; destinations cannot be overridden.
    function release(address payer, bytes32 requestId, bytes calldata committeeSig) external nonReentrant {
        Deposit storage record = _deposits[payer][requestId];
        if (record.status != Status.Open) revert NotOpen();
        if (block.timestamp >= record.expiry) revert ReleaseExpired();
        if (ECDSA.recover(releaseDigest(payer, requestId), committeeSig) != committee) revert InvalidSigner();

        record.status = Status.Released;
        totalOpen -= record.amount;
        Split memory split = record.split;
        if (split.treasuryAmount != 0) token.safeTransfer(split.treasury, split.treasuryAmount);
        if (split.finderAmount != 0) token.safeTransfer(split.finder, split.finderAmount);
        if (split.landownerAmount != 0) token.safeTransfer(split.landowner, split.landownerAmount);
        if (split.discovererAmount != 0) token.safeTransfer(split.discoverer, split.discovererAmount);
        if (split.burnAmount != 0) IBurnableTap(address(token)).burn(split.burnAmount);
        emit Released(requestId, payer, msg.sender, record.splitHash, record.amount, committee, committeeEpoch);
    }

    /// @notice The expiry boundary belongs exclusively to refunds, which always return to the payer.
    function refund(address payer, bytes32 requestId) external nonReentrant {
        Deposit storage record = _deposits[payer][requestId];
        if (record.status != Status.Open) revert NotOpen();
        if (block.timestamp < record.expiry) revert RefundTooEarly();
        record.status = Status.Refunded;
        totalOpen -= record.amount;
        token.safeTransfer(record.payer, record.amount);
        emit Refunded(requestId, record.payer, msg.sender, record.amount);
    }

    function getDeposit(address payer, bytes32 requestId) external view returns (Deposit memory) {
        return _deposits[payer][requestId];
    }

    function hashSplit(Split memory split) public pure returns (bytes32) {
        return keccak256(abi.encode(SPLIT_TYPEHASH, split));
    }

    /// @notice The current epoch invalidates old signatures even if an old committee key later returns.
    function releaseDigest(address payer, bytes32 requestId) public view returns (bytes32) {
        Deposit storage record = _deposits[payer][requestId];
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RELEASE_TYPEHASH, requestId, payer, record.amount, record.splitHash, record.expiry, committeeEpoch
                )
            )
        );
    }

    /// @notice A signed rotation uses the current, unconsumed nonce and has a submission deadline.
    function rotationDigest(address successor, uint256 deadline) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(ROTATION_TYPEHASH, successor, rotationNonce, committeeEpoch, deadline))
            );
    }

    function proposeCommittee(address successor, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (ECDSA.recover(rotationDigest(successor, deadline), signature) != committee) revert InvalidSigner();
        _scheduleCommittee(successor, committee, false);
    }

    function proposeCommitteeByAdmin(address successor) external nonReentrant {
        _onlyAdmin();
        _scheduleCommittee(successor, admin, true);
    }

    function applyCommittee() external nonReentrant {
        CommitteeProposal memory proposal = pendingCommittee;
        if (proposal.successor == address(0)) revert NoProposal();
        if (block.timestamp < proposal.executableAt) revert DelayNotElapsed();
        address previous = committee;
        committee = proposal.successor;
        committeeEpoch++;
        delete pendingCommittee;
        emit CommitteeRotated(previous, committee, committeeEpoch, proposal.nonce);
    }

    function proposeAdmin(address successor) external nonReentrant {
        _onlyAdmin();
        _validateAuthority(successor);
        if (successor == admin) revert InvalidAddress();
        uint256 executableAt = block.timestamp + ROTATION_DELAY;
        pendingAdmin = AdminProposal(successor, executableAt);
        emit AdminTransferScheduled(admin, successor, executableAt);
    }

    /// @notice Only the proposed successor can accept, after the same public delay as key rotations.
    function acceptAdmin() external nonReentrant {
        AdminProposal memory proposal = pendingAdmin;
        if (proposal.successor == address(0)) revert NoProposal();
        if (msg.sender != proposal.successor) revert Unauthorized();
        if (block.timestamp < proposal.executableAt) revert DelayNotElapsed();
        address previous = admin;
        admin = proposal.successor;
        delete pendingAdmin;
        _clearCommitteeProposal();
        // Invalidate any unsubmitted rotation signed before the handover.
        rotationNonce++;
        emit AdminTransferred(previous, admin);
    }

    function _scheduleCommittee(address successor, address authority, bool adminOrigin) private {
        if (pendingCommittee.adminOrigin && !adminOrigin) revert AdminRecoveryPending();
        _validateAuthority(successor);
        if (successor == committee) revert InvalidAddress();
        _clearCommitteeProposal();
        uint256 nonce = rotationNonce++;
        uint256 executableAt = block.timestamp + ROTATION_DELAY;
        pendingCommittee = CommitteeProposal(successor, executableAt, nonce, adminOrigin);
        emit CommitteeRotationScheduled(
            committee, successor, authority, executableAt, nonce, committeeEpoch, adminOrigin
        );
    }

    function _clearCommitteeProposal() private {
        CommitteeProposal memory proposal = pendingCommittee;
        if (proposal.successor != address(0)) {
            delete pendingCommittee;
            emit CommitteeRotationCancelled(proposal.successor, proposal.nonce);
        }
    }

    function _onlyAdmin() private view {
        if (msg.sender != admin) revert Unauthorized();
    }

    function _validateAuthority(address authority) private view {
        if (authority == address(0) || authority == address(this)) revert InvalidAddress();
    }

    function _validateRecipient(address recipient, uint256 amount) private view {
        if (amount == 0) {
            if (recipient != address(0)) revert InvalidSplit();
        } else if (recipient == address(0) || recipient == address(this)) {
            revert InvalidSplit();
        }
    }
}
