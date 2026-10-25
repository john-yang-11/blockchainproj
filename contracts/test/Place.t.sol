// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Place} from "../src/Place.sol";

contract PlaceTest is Test {
    Place place;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant BASE = 0.0001 ether;
    uint256 constant STEP = 0.00005 ether;
    uint256 constant COOLDOWN = 30;

    event PixelPlaced(
        uint256 indexed pixelId, address indexed painter, uint8 color, uint16 overwrites, uint256 price
    );

    function setUp() public {
        place = new Place(128, 128, BASE, STEP, COOLDOWN);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function test_placeSetsColorAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit PixelPlaced(5 * 128 + 3, alice, 7, 0, BASE);
        vm.prank(alice);
        place.placePixel{value: BASE}(3, 5, 7);

        assertEq(place.colorOf(3, 5), 7);
        assertEq(place.overwritesOf(3, 5), 1);
        assertEq(place.totalPlacements(), 1);
        assertEq(address(place).balance, BASE);
    }

    function test_priceRisesOnOverwrite() public {
        assertEq(place.priceOf(0, 0), BASE);
        vm.prank(alice);
        place.placePixel{value: BASE}(0, 0, 1);
        assertEq(place.priceOf(0, 0), BASE + STEP);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Place.InsufficientPayment.selector, BASE + STEP, BASE));
        place.placePixel{value: BASE}(0, 0, 2);

        vm.prank(bob);
        place.placePixel{value: BASE + STEP}(0, 0, 2);
        assertEq(place.colorOf(0, 0), 2);
        assertEq(place.priceOf(0, 0), BASE + 2 * STEP);
        // neighbours untouched
        assertEq(place.priceOf(1, 0), BASE);
        assertEq(place.colorOf(1, 0), 0);
    }

    function test_cooldown() public {
        vm.startPrank(alice);
        place.placePixel{value: BASE}(0, 0, 1);
        assertEq(place.cooldownRemaining(alice), COOLDOWN);

        vm.expectRevert(abi.encodeWithSelector(Place.CooldownActive.selector, block.timestamp + COOLDOWN));
        place.placePixel{value: BASE}(1, 0, 1);

        vm.warp(block.timestamp + COOLDOWN);
        assertEq(place.cooldownRemaining(alice), 0);
        place.placePixel{value: BASE}(1, 0, 1);
        vm.stopPrank();
    }

    function test_cooldownIsPerWallet() public {
        vm.prank(alice);
        place.placePixel{value: BASE}(0, 0, 1);
        vm.prank(bob);
        place.placePixel{value: BASE}(1, 0, 1);
    }

    function test_refundsExcess() public {
        uint256 before = alice.balance;
        vm.prank(alice);
        place.placePixel{value: 1 ether}(0, 0, 1);
        assertEq(alice.balance, before - BASE);
    }

    function test_bounds() public {
        vm.startPrank(alice);
        vm.expectRevert(Place.OutOfBounds.selector);
        place.placePixel{value: BASE}(128, 0, 1);
        vm.expectRevert(Place.OutOfBounds.selector);
        place.placePixel{value: BASE}(0, 128, 1);
        vm.expectRevert(Place.InvalidColor.selector);
        place.placePixel{value: BASE}(0, 0, 16);
        vm.stopPrank();
    }

    function test_canvasPacking() public {
        // Paint the last pixel of word 0 and first pixel of word 1, plus the very last pixel.
        _paint(alice, 63, 0, 0xA);
        _paint(alice, 64, 0, 0xB);
        _paint(alice, 127, 127, 0xF);

        uint256[] memory words = place.getCanvas(0, type(uint256).max);
        assertEq(words.length, 256);
        assertEq(words[0] >> 252, 0xA);
        assertEq(words[1] & 0xF, 0xB);
        assertEq(words[255] >> 252, 0xF);

        uint256[] memory counts = place.getOverwrites(0, 1000000);
        assertEq(counts.length, 1024);
        assertEq(counts[3] >> 240, 1); // pixel 63 -> word 3, slot 15

        // Ranged reads line up with the full read and clamp at the end.
        uint256[] memory slice = place.getCanvas(1, 2);
        assertEq(slice.length, 2);
        assertEq(slice[0], words[1]);
        assertEq(place.getCanvas(250, 100).length, 6);
        assertEq(place.getCanvas(256, 1).length, 0);
    }

    function test_rPlaceSizedCanvas() public {
        Place big = new Place(1000, 1000, BASE, STEP, COOLDOWN);
        vm.prank(alice);
        big.placePixel{value: BASE}(999, 999, 7);
        assertEq(big.colorOf(999, 999), 7);
        uint256[] memory last = big.getCanvas(15624, 10);
        assertEq(last.length, 1);
        assertEq(last[0] >> 252, 7);
    }

    function test_leaderboard() public {
        _paint(alice, 0, 0, 1);
        _paint(alice, 1, 0, 1);
        _paint(bob, 0, 0, 2);

        assertEq(place.playerCount(), 2);
        (address[] memory addrs, Place.Player[] memory stats) = place.getPlayers(0, 10);
        assertEq(addrs[0], alice);
        assertEq(stats[0].placed, 2);
        assertEq(stats[0].spent, 2 * BASE);
        assertEq(addrs[1], bob);
        assertEq(stats[1].spent, BASE + STEP);

        (addrs,) = place.getPlayers(1, 10);
        assertEq(addrs.length, 1);
        (addrs,) = place.getPlayers(5, 10);
        assertEq(addrs.length, 0);
    }

    function test_withdraw() public {
        _paint(alice, 0, 0, 1);
        address payable sink = payable(makeAddr("sink"));

        vm.prank(alice);
        vm.expectRevert(Place.NotOwner.selector);
        place.withdraw(sink);

        place.withdraw(sink);
        assertEq(sink.balance, BASE);
        assertEq(address(place).balance, 0);
    }

    function testFuzz_placeAnywhere(uint256 x, uint256 y, uint8 color) public {
        x = bound(x, 0, 127);
        y = bound(y, 0, 127);
        color = uint8(bound(color, 0, 15));
        _paint(alice, x, y, color);
        assertEq(place.colorOf(x, y), color);
        uint256 id = y * 128 + x;
        assertEq((place.getCanvas(id / 64, 1)[0] >> ((id % 64) * 4)) & 0xF, color);
    }

    function _paint(address who, uint256 x, uint256 y, uint8 color) internal {
        vm.warp(block.timestamp + COOLDOWN);
        uint256 price = place.priceOf(x, y);
        vm.prank(who);
        place.placePixel{value: price}(x, y, color);
    }
}
