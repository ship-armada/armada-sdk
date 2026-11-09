// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Generator for test/vectors/nitro-state-vectors.json (ADR-0020 H7 parity). This script runs inside an
// armada-nitro checkout (it imports that repo's contracts). See test/vectors/tools/README.md for the
// exact command, the armada-nitro commit it is pinned to, and how to copy it in.
//
// It emits one go-nitro parity vector as a single JSON line prefixed with "VECTORS=". armada-sdk
// src/disclosure/nitro.test.ts reconstructs the inputs, recomputes channelId, the state hash and the
// ECDSA signer with src/disclosure/nitro.ts, and asserts byte-identical outputs.

import {Script, console} from 'forge-std/Script.sol';
import {NitroUtils} from 'src/nitro/libraries/NitroUtils.sol';
import {INitroTypes} from 'src/nitro/interfaces/INitroTypes.sol';
import {ExitFormat as Outcome} from '@statechannels/exit-format/contracts/ExitFormat.sol';

contract NitroVectors is Script {
    uint256 constant USER_PK = 0xA11CE;
    uint256 constant HUB_PK = 0xB0B;
    uint256 constant NONCE = 424242;
    address constant APP = 0xdEADbeEF00000000000000000000000000000001;
    uint48 constant CHALLENGE = 86400;
    address constant ASSET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 constant AMT_USER = 10000000000;
    uint256 constant AMT_HUB = 400000000;
    uint48 constant TURN = 7;

    function _fp() internal view returns (INitroTypes.FixedPart memory fp) {
        address[] memory p = new address[](2);
        p[0] = vm.addr(USER_PK);
        p[1] = vm.addr(HUB_PK);
        fp = INitroTypes.FixedPart({participants: p, channelNonce: uint64(NONCE), appDefinition: APP, challengeDuration: CHALLENGE});
    }

    function _vp() internal view returns (INitroTypes.VariablePart memory vp) {
        Outcome.Allocation[] memory allocs = new Outcome.Allocation[](2);
        allocs[0] = Outcome.Allocation({destination: bytes32(uint256(uint160(vm.addr(USER_PK)))), amount: AMT_USER, allocationType: 0, metadata: ''});
        allocs[1] = Outcome.Allocation({destination: bytes32(uint256(uint160(vm.addr(HUB_PK)))), amount: AMT_HUB, allocationType: 0, metadata: ''});
        Outcome.SingleAssetExit[] memory o = new Outcome.SingleAssetExit[](1);
        o[0] = Outcome.SingleAssetExit({asset: ASSET, assetMetadata: Outcome.AssetMetadata({assetType: Outcome.AssetType.Default, metadata: ''}), allocations: allocs});
        vp = INitroTypes.VariablePart({outcome: o, appData: hex'c0ffee', turnNum: TURN, isFinal: false});
    }

    function run() external {
        bytes32 channelId = NitroUtils.getChannelId(_fp());
        bytes32 stateHash = NitroUtils.hashState(_fp(), _vp());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, NitroUtils.prefixedHash(stateHash));
        address recovered = NitroUtils.recoverSigner(stateHash, INitroTypes.Signature({v: v, r: r, s: s}));

        string memory o = 'vec';
        vm.serializeAddress(o, 'user', vm.addr(USER_PK));
        vm.serializeAddress(o, 'hub', vm.addr(HUB_PK));
        vm.serializeUint(o, 'channelNonce', NONCE);
        vm.serializeAddress(o, 'appDefinition', APP);
        vm.serializeUint(o, 'challengeDuration', uint256(CHALLENGE));
        vm.serializeAddress(o, 'asset', ASSET);
        vm.serializeBytes32(o, 'destUser', bytes32(uint256(uint160(vm.addr(USER_PK)))));
        vm.serializeBytes32(o, 'destHub', bytes32(uint256(uint160(vm.addr(HUB_PK)))));
        vm.serializeUint(o, 'amtUser', AMT_USER);
        vm.serializeUint(o, 'amtHub', AMT_HUB);
        vm.serializeBytes(o, 'appData', hex'c0ffee');
        vm.serializeUint(o, 'turnNum', uint256(TURN));
        vm.serializeBool(o, 'isFinal', false);
        vm.serializeBytes32(o, 'channelId', channelId);
        vm.serializeBytes32(o, 'stateHash', stateHash);
        vm.serializeAddress(o, 'signer', recovered);
        vm.serializeUint(o, 'sigV', uint256(v));
        vm.serializeBytes32(o, 'sigR', r);
        string memory json = vm.serializeBytes32(o, 'sigS', s);
        console.log(string.concat('VECTORS=', json));
    }
}
