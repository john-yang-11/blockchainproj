// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Place} from "../src/Place.sol";

/// Env overrides (all optional): WIDTH, HEIGHT, BASE_PRICE (wei), PRICE_INCREMENT (wei), COOLDOWN (seconds)
contract Deploy is Script {
    function run() external returns (Place place) {
        uint256 width = vm.envOr("WIDTH", uint256(1000));
        uint256 height = vm.envOr("HEIGHT", uint256(1000));
        uint256 basePrice = vm.envOr("BASE_PRICE", uint256(0.00001 ether));
        uint256 increment = vm.envOr("PRICE_INCREMENT", uint256(0.000005 ether));
        uint256 cooldown = vm.envOr("COOLDOWN", uint256(30));

        vm.startBroadcast();
        place = new Place(width, height, basePrice, increment, cooldown);
        vm.stopBroadcast();

        console.log("Place deployed at", address(place));
        console.log("Deploy block", block.number);
    }
}
