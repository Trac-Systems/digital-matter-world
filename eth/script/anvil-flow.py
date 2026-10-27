#!/usr/bin/env python3
"""Run disposable escrow transactions against a fresh, memory-only loopback Anvil."""

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
TARGET = Path(os.environ.get("DMW_BUILD_ROOT", ROOT.parent.parent / "build")) / "target"
WAD = 10**18
ZERO = "0x" + "00" * 20
DEPOSIT = "deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)"
RELEASE_TYPES = [
    ("requestId", "bytes32"), ("payer", "address"), ("amount", "uint256"),
    ("splitHash", "bytes32"), ("expiry", "uint256"), ("committeeEpoch", "uint256"),
]
ROTATION_TYPES = [
    ("newCommittee", "address"), ("nonce", "uint256"),
    ("committeeEpoch", "uint256"), ("deadline", "uint256"),
]


def run():
    if shutil.disk_usage("/").free < 100_000_000_000:
        raise RuntimeError("Less than 100 GB free; refusing to build or start Anvil")
    for binary in ("forge", "cast", "anvil"):
        if not shutil.which(binary):
            raise RuntimeError(f"Required executable is missing: {binary}")
    TARGET.mkdir(parents=True, exist_ok=True)
    evidence = Path(tempfile.mkdtemp(prefix="escrow-flow-", dir=TARGET))
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", int(os.environ.get("DMW_ESCROW_TEST_PORT", "0"))))
        port = reservation.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    checks = []
    gas = []
    receipts = []
    process = None

    def check(condition, label):
        if not condition:
            raise AssertionError(label)
        checks.append(label)

    def rpc(method, *params):
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)}).encode()
        request = urllib.request.Request(endpoint, payload, {"Content-Type": "application/json"})
        with opener.open(request, timeout=10) as response:
            body = json.load(response)
        if "error" in body:
            raise RuntimeError(f"{method}: {body['error']}")
        return body["result"]

    def cast(*args):
        return subprocess.check_output(["cast", *map(str, args)], cwd=ROOT, text=True).strip()

    def calldata(signature, *args):
        return cast("calldata", signature, *args)

    def call(to, signature, *args):
        return rpc("eth_call", {"to": to, "data": calldata(signature, *args)}, "latest")

    def number(to, signature, *args):
        return int(call(to, signature, *args), 16)

    def word(encoded, index):
        return int(encoded[2 + 64 * index:2 + 64 * (index + 1)], 16)

    def deposit_status(escrow, payer, request_id):
        return word(call(escrow, "getDeposit(address,bytes32)", payer, request_id), 1)

    def timestamp():
        return int(rpc("eth_getBlockByNumber", "latest", False)["timestamp"], 16)

    def transact(label, sender, to, signature, *args):
        tx = {"from": sender, "to": to, "data": calldata(signature, *args)}
        tx["gas"] = hex(int(rpc("eth_estimateGas", tx), 16) * 12 // 10)
        tx_hash = rpc("eth_sendTransaction", tx)
        receipt = rpc("eth_getTransactionReceipt", tx_hash)
        if not receipt or int(receipt["status"], 16) != 1:
            raise RuntimeError(f"Transaction failed: {label}")
        gas.append({"call": label, "gasUsed": int(receipt["gasUsed"], 16), "transactionHash": tx_hash})
        receipts.append(receipt)
        return receipt

    def refused(label, sender, to, signature, *args):
        try:
            rpc("eth_call", {"from": sender, "to": to, "data": calldata(signature, *args)}, "latest")
        except RuntimeError as error:
            if "revert" not in str(error).lower():
                raise
            checks.append(label)
            return
        raise AssertionError(f"Expected refusal: {label}")

    def sign_typed(signer, escrow, primary, fields, message):
        data = {
            "types": {
                "EIP712Domain": [{"name": k, "type": t} for k, t in (
                    ("name", "string"), ("version", "string"), ("chainId", "uint256"),
                    ("verifyingContract", "address"))],
                primary: [{"name": k, "type": t} for k, t in fields],
            },
            "primaryType": primary,
            "domain": {"name": "DmwEscrow", "version": "1", "chainId": 31337, "verifyingContract": escrow},
            "message": message,
        }
        return rpc("eth_signTypedData_v4", signer, json.dumps(data))

    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"Signal {signum}")

    previous_signals = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        with (evidence / "anvil.log").open("w") as log:
            process = subprocess.Popen([
                "anvil", "--host", "127.0.0.1", "--port", str(port), "--chain-id", "31337", "--silent",
            ], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        (evidence / "anvil.pid").write_text(f"{process.pid}\n")
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError("Anvil exited before becoming ready")
            try:
                if rpc("eth_chainId") == "0x7a69":
                    break
            except (OSError, RuntimeError):
                pass
            time.sleep(0.05)
        else:
            raise RuntimeError("Anvil startup timed out")

        admin, committee, payer, treasury, finder, landowner, relayer, successor, new_admin, otherParty = rpc("eth_accounts")[:10]
        env = os.environ.copy()
        env["FOUNDRY_BROADCAST"] = str(evidence / "broadcast")
        deployment = subprocess.run([
            str(ROOT / "foundry"), "script", "script/DeployEscrow.s.sol:DeployEscrow", "--offline",
            "--sig", "run(address,address,address)", admin, committee, payer,
            "--rpc-url", endpoint, "--unlocked", "--sender", admin, "--broadcast", "--slow",
        ], cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        (evidence / "deploy.log").write_text(deployment.stdout)
        if deployment.returncode:
            raise RuntimeError(f"Local deployment failed; see {evidence / 'deploy.log'}")
        broadcast = json.loads((evidence / "broadcast/DeployEscrow.s.sol/31337/run-latest.json").read_text())
        deployed = {t["contractName"]: t["contractAddress"] for t in broadcast["transactions"] if t["transactionType"] == "CREATE"}
        token, escrow = deployed["LocalTap"], deployed["DmwEscrow"]
        check(number(token, "balanceOf(address)", payer) == 1000 * WAD, "payer funded by local stand-in")
        check(number(escrow, "totalOpen()") == 0, "fresh escrow has no deposits")
        transact("approve", payer, token, "approve(address,uint256)", escrow, 300 * WAD)

        split = f"({treasury},{35*WAD},{finder},{30*WAD},{landowner},{15*WAD},{'0x' + '00'*20},0,{20*WAD})"
        split_hash = call(escrow, "hashSplit((address,uint256,address,uint256,address,uint256,address,uint256,uint256))", split)
        first, second, third = ["0x" + f"{n:064x}" for n in (1, 2, 3)]
        expiry = timestamp() + 10 * 86400
        transact("fund unrelated payer", payer, token, "transfer(address,uint256)", otherParty, 1)
        transact("approve unrelated payer", otherParty, token, "approve(address,uint256)", escrow, 1)
        all_burn = f"({'0x' + '00'*20},0,{'0x' + '00'*20},0,{'0x' + '00'*20},0,{'0x' + '00'*20},0,1)"
        transact("deposit (same ID, unrelated payer)", otherParty, escrow, DEPOSIT, first, 1, all_burn,
                 timestamp() + 3600 + 60)
        check(deposit_status(escrow, payer, first) == 0, "unrelated deposit leaves intended payer namespace unused")
        transact("deposit (landowner)", payer, escrow, DEPOSIT, first, 100 * WAD, split, expiry)
        check(deposit_status(escrow, payer, first) == deposit_status(escrow, otherParty, first) == 1,
              "same request ID is open independently for both payers")
        check(number(escrow, "totalOpen()") == number(token, "balanceOf(address)", escrow) == 100 * WAD + 1,
              "deposit conservation")
        message = {"requestId": first, "payer": payer, "amount": str(100 * WAD), "splitHash": split_hash,
                   "expiry": str(expiry), "committeeEpoch": "0"}
        sig = sign_typed(committee, escrow, "Release", RELEASE_TYPES, message)
        refused("release signature cannot cross payer namespace", relayer, escrow, "release(address,bytes32,bytes)", otherParty, first, sig)
        refused("refund before expiry refused", relayer, escrow, "refund(address,bytes32)", payer, first)
        transact("release (landowner)", relayer, escrow, "release(address,bytes32,bytes)", payer, first, sig)
        check(deposit_status(escrow, payer, first) == 2 and deposit_status(escrow, otherParty, first) == 1,
              "release leaves unrelated payer deposit open")
        check(number(token, "balanceOf(address)", treasury) == 35 * WAD, "treasury paid")
        check(number(token, "balanceOf(address)", finder) == 30 * WAD, "finder paid")
        check(number(token, "balanceOf(address)", landowner) == 15 * WAD, "landowner paid")
        check(number(token, "totalSupply()") == 980 * WAD, "burn reduces supply")
        refused("release replay refused", relayer, escrow, "release(address,bytes32,bytes)", payer, first, sig)
        refused("released request cannot refund", relayer, escrow, "refund(address,bytes32)", payer, first)
        refused("released request ID stays used", payer, escrow, DEPOSIT, first, 100 * WAD, split, expiry)

        no_land = f"({treasury},{35*WAD},{finder},{30*WAD},{'0x' + '00'*20},0,{'0x' + '00'*20},0,{35*WAD})"
        no_land_hash = call(escrow, "hashSplit((address,uint256,address,uint256,address,uint256,address,uint256,uint256))", no_land)
        transact("deposit (no landowner)", payer, escrow, DEPOSIT, second, 100 * WAD, no_land, expiry)
        transact("deposit (refund)", payer, escrow, DEPOSIT, third, 100 * WAD, split, expiry)
        stale_message = dict(message, requestId=second, splitHash=no_land_hash)
        stale_sig = sign_typed(committee, escrow, "Release", RELEASE_TYPES, stale_message)
        deadline = timestamp() + 86400
        rotation = {"newCommittee": successor, "nonce": "0", "committeeEpoch": "0", "deadline": str(deadline)}
        rotation_sig = sign_typed(committee, escrow, "RotateCommittee", ROTATION_TYPES, rotation)
        transact("proposeCommittee", relayer, escrow, "proposeCommittee(address,uint256,bytes)", successor, deadline, rotation_sig)
        refused("rotation signature replay refused", relayer, escrow, "proposeCommittee(address,uint256,bytes)", successor, deadline, rotation_sig)
        refused("rotation delay enforced", relayer, escrow, "applyCommittee()")
        rpc("evm_increaseTime", 3 * 86400)
        rpc("evm_mine")
        transact("applyCommittee (signed)", relayer, escrow, "applyCommittee()")
        check(number(escrow, "committeeEpoch()") == 1, "signed rotation advances epoch")
        refused("old committee signature refused", relayer, escrow, "release(address,bytes32,bytes)", payer, second, stale_sig)
        new_sig = sign_typed(successor, escrow, "Release", RELEASE_TYPES, dict(stale_message, committeeEpoch="1"))
        transact("release (no landowner)", relayer, escrow, "release(address,bytes32,bytes)", payer, second, new_sig)
        check(number(token, "totalSupply()") == 945 * WAD, "missing landowner allocation is burned")
        check(number(escrow, "totalOpen()") == number(token, "balanceOf(address)", escrow) == 100 * WAD + 1,
              "both refundable deposits remain funded")

        transact("proposeCommitteeByAdmin", admin, escrow, "proposeCommitteeByAdmin(address)", committee)
        recovery = call(escrow, "pendingCommittee()")
        check(word(recovery, 3) == 1, "committee recovery records admin origin")
        nonce = number(escrow, "rotationNonce()")
        interference_deadline = timestamp() + 4 * 86400
        interference = {"newCommittee": otherParty, "nonce": str(nonce), "committeeEpoch": "1",
                        "deadline": str(interference_deadline)}
        interference_sig = sign_typed(successor, escrow, "RotateCommittee", ROTATION_TYPES, interference)
        refused("committee cannot replace admin recovery", relayer, escrow, "proposeCommittee(address,uint256,bytes)",
                otherParty, interference_deadline, interference_sig)
        check(call(escrow, "pendingCommittee()") == recovery and number(escrow, "rotationNonce()") == nonce,
              "refused interference preserves proposal and nonce")
        transact("proposeAdmin", admin, escrow, "proposeAdmin(address)", new_admin)
        refused("admin handover delay enforced", new_admin, escrow, "acceptAdmin()")
        rpc("evm_setNextBlockTimestamp", word(recovery, 1))
        rpc("evm_mine")
        refused("committee cannot replace mature admin recovery", relayer, escrow, "proposeCommittee(address,uint256,bytes)",
                otherParty, interference_deadline, interference_sig)
        check(call(escrow, "pendingCommittee()") == recovery and number(escrow, "rotationNonce()") == nonce,
              "maturity interference does not restart recovery delay")
        transact("applyCommittee (admin)", relayer, escrow, "applyCommittee()")
        check(number(escrow, "committee()") == int(committee, 16), "admin recovery succeeds despite current committee interference")
        admin_at = word(call(escrow, "pendingAdmin()"), 1)
        if timestamp() < admin_at:
            rpc("evm_setNextBlockTimestamp", admin_at)
            rpc("evm_mine")
        transact("acceptAdmin", new_admin, escrow, "acceptAdmin()")
        check(number(escrow, "admin()") == int(new_admin, 16), "successor accepted administration")
        refused("old admin loses authority", admin, escrow, "proposeCommitteeByAdmin(address)", successor)
        refused("admin cannot release unsigned", new_admin, escrow, "release(address,bytes32,bytes)", payer, third, "0x")
        refund_sig = sign_typed(committee, escrow, "Release", RELEASE_TYPES, dict(message, requestId=third, committeeEpoch="2"))
        rpc("evm_setNextBlockTimestamp", expiry)
        rpc("evm_mine")
        refused("release at expiry refused", relayer, escrow, "release(address,bytes32,bytes)", payer, third, refund_sig)
        transact("refund", relayer, escrow, "refund(address,bytes32)", payer, third)
        check(number(token, "balanceOf(address)", payer) == 800 * WAD - 1, "refund returns full amount to payer")
        check(number(token, "balanceOf(address)", relayer) == 0, "refund relayer receives no TAP")
        check(number(token, "balanceOf(address)", admin) == number(token, "balanceOf(address)", new_admin) == 0,
              "administration moves no TAP")
        transact("refund (same ID, unrelated payer)", relayer, escrow, "refund(address,bytes32)", otherParty, first)
        check(number(token, "balanceOf(address)", otherParty) == 1, "unrelated deposit refunds only to its own payer")
        check(deposit_status(escrow, payer, first) == 2 and deposit_status(escrow, otherParty, first) == 3,
              "same request ID retains independent terminal states")
        check(number(escrow, "totalOpen()") == number(token, "balanceOf(address)", escrow) == 0,
              "all requests settled with zero escrow balance")
        refused("refund replay refused", relayer, escrow, "refund(address,bytes32)", payer, third)
        refused("refunded request cannot release", relayer, escrow, "release(address,bytes32,bytes)", payer, third, refund_sig)
        result = {"checks": checks, "checkCount": len(checks), "gas": gas, "receipts": receipts, "token": token, "escrow": escrow,
                  "chainId": 31337, "anvilPid": process.pid}
        (evidence / "flow.json").write_text(json.dumps(result, indent=2) + "\n")
        print(f"PASS: {len(checks)} checks, {len(gas)} transactions. Evidence: {evidence}")
        for entry in gas:
            print(f"{entry['call']}: {entry['gasUsed']} gas")
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            (evidence / "anvil-stopped.json").write_text(json.dumps({"pid": process.pid, "returncode": process.returncode}) + "\n")
        for sig, previous in previous_signals.items():
            signal.signal(sig, previous)


if __name__ == "__main__":
    run()
