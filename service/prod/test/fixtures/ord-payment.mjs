// Captured ord-tap JSON data. The auth references identify public inscriptions.
export default {
  "fees": [
    {
      "role": "finder",
      "to": "bcrt1pf3mp9849dgkpgczwy25njkywm4yhygptzufa8em5y6kfpfsg9kzqx52r0l",
      "ticker": "tap",
      "amount": "300000000000000000",
      "tt": "a",
      "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|finder"
    },
    {
      "role": "treasury",
      "to": "bcrt1ph50tmywvdugz0wdajdp4zch0rlklgcduedlqvy89fd6wfnu7gm3squ8f6z",
      "ticker": "tap",
      "amount": "350000000000000000",
      "tt": "a",
      "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|treasury"
    },
    {
      "role": "burn",
      "to": "1BitcoinEaterAddressDontSendf59kuE",
      "ticker": "tap",
      "amount": "350000000000000000",
      "tt": "a",
      "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|burn"
    }
  ],
  "payload": {
    "p": "tap",
    "op": "token-auth",
    "redeem": {
      "auth": "7f2a074a1cfd31f265e79e45b0c1b47ee7908bb9259b9ad2837b8b77b0d32da2i0", // gitleaks:allow -- public regtest inscription ID, not a credential
      "items": [
        {
          "tick": "tap",
          "amt": "0.3",
          "address": "bcrt1pf3mp9849dgkpgczwy25njkywm4yhygptzufa8em5y6kfpfsg9kzqx52r0l",
          "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|finder"
        },
        {
          "tick": "tap",
          "amt": "0.35",
          "address": "bcrt1ph50tmywvdugz0wdajdp4zch0rlklgcduedlqvy89fd6wfnu7gm3squ8f6z",
          "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|treasury"
        }
      ],
      "data": "",
      "actions": []
    },
    "hash": "2a8728d4b002837e3fbabe222b1f42255ea1cccbe32c5b4d461e66fa9626190e",
    "sig": {
      "v": "1",
      "r": "86620673240539416467469068415362821864066559827584636980151110133759623113286",
      "s": "11038640384511550926985891840690334193954171544932086668928146090355038094936"
    },
    "salt": "d47e3e58b0bc4e531ec4e3ec8205203f"
  },
  "transfers": [
    {
      "tick": "tap",
      "addr": "bcrt1pdmwh8wp9xgclh2kc3k3e88n6agfmev8yv6uuynz9unk7m52fz7fqq7u33e",
      "taddr": "bcrt1pf3mp9849dgkpgczwy25njkywm4yhygptzufa8em5y6kfpfsg9kzqx52r0l",
      "blck": 119,
      "amt": "300000000000000000",
      "trf": "0",
      "bal": "999700000000000000000",
      "tbal": "300000000000000000",
      "tx": "28352ee3774f56416fc1af5cb3233b1d197eb567ef3c59ceab6315cfba6d240d",
      "vo": 0,
      "val": "10000",
      "ins": "28352ee3774f56416fc1af5cb3233b1d197eb567ef3c59ceab6315cfba6d240di0",
      "num": 5,
      "ts": 1793060674,
      "fail": false,
      "int": true,
      "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|finder"
    },
    {
      "tick": "tap",
      "addr": "bcrt1pdmwh8wp9xgclh2kc3k3e88n6agfmev8yv6uuynz9unk7m52fz7fqq7u33e",
      "taddr": "bcrt1ph50tmywvdugz0wdajdp4zch0rlklgcduedlqvy89fd6wfnu7gm3squ8f6z",
      "blck": 119,
      "amt": "350000000000000000",
      "trf": "0",
      "bal": "999350000000000000000",
      "tbal": "350000000000000000",
      "tx": "28352ee3774f56416fc1af5cb3233b1d197eb567ef3c59ceab6315cfba6d240d",
      "vo": 0,
      "val": "10000",
      "ins": "28352ee3774f56416fc1af5cb3233b1d197eb567ef3c59ceab6315cfba6d240di0",
      "num": 5,
      "ts": 1793060674,
      "fail": false,
      "int": true,
      "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|treasury"
    }
  ],
  "redeems": [
    {
      "addr": "bcrt1pdmwh8wp9xgclh2kc3k3e88n6agfmev8yv6uuynz9unk7m52fz7fqq7u33e",
      "iaddr": "bcrt1pdmwh8wp9xgclh2kc3k3e88n6agfmev8yv6uuynz9unk7m52fz7fqq7u33e",
      "rdm": {
        "auth": "7f2a074a1cfd31f265e79e45b0c1b47ee7908bb9259b9ad2837b8b77b0d32da2i0", // gitleaks:allow -- public regtest inscription ID, not a credential
        "items": [
          {
            "tick": "tap",
            "amt": "0.3",
            "address": "bcrt1pf3mp9849dgkpgczwy25njkywm4yhygptzufa8em5y6kfpfsg9kzqx52r0l",
            "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|finder"
          },
          {
            "tick": "tap",
            "amt": "0.35",
            "address": "bcrt1ph50tmywvdugz0wdajdp4zch0rlklgcduedlqvy89fd6wfnu7gm3squ8f6z",
            "dta": "dmw-pay-v2|998999b221b5df18055092aee537379db65a28b8f9006897b861dfc54fdb5ebd|treasury"
          }
        ],
        "data": "",
        "actions": []
      },
      "sig": {
        "v": "1",
        "r": "86620673240539416467469068415362821864066559827584636980151110133759623113286",
        "s": "11038640384511550926985891840690334193954171544932086668928146090355038094936"
      },
      "hash": "2a8728d4b002837e3fbabe222b1f42255ea1cccbe32c5b4d461e66fa9626190e",
      "slt": "d47e3e58b0bc4e531ec4e3ec8205203f",
      "blck": 119,
      "tx": "28352ee3774f56416fc1af5cb3233b1d197eb567ef3c59ceab6315cfba6d240d",
      "vo": 0,
      "val": "10000",
      "ins": "28352ee3774f56416fc1af5cb3233b1d197eb567ef3c59ceab6315cfba6d240di0",
      "num": 5,
      "ts": 1793060674
    }
  ]
};
