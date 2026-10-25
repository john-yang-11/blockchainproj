// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Place — r/place on-chain
/// @notice Pay to paint a pixel. Each overwrite raises that pixel's price, each wallet has a cooldown.
/// @dev Storage layout is packed for cheap reads/writes:
///      - colors: 4 bits per pixel (16-color palette), 64 pixels per storage word
///      - overwrite counts: 16 bits per pixel, 16 pixels per storage word
///      - per-player stats (cooldown timestamp + leaderboard counters) share a single slot
///      A 1000x1000 canvas (r/place 2017 size) is 15,625 color words, read in a few ranged eth_calls.
contract Place {
    uint256 public constant COLORS = 16;
    uint256 private constant PIXELS_PER_COLOR_WORD = 64;
    uint256 private constant PIXELS_PER_COUNT_WORD = 16;

    struct Player {
        uint64 lastPlacedAt;
        uint64 placed;
        uint128 spent;
    }

    uint256 public immutable width;
    uint256 public immutable height;
    uint256 public immutable basePrice;
    uint256 public immutable priceIncrement;
    uint256 public immutable cooldown;

    address public owner;
    uint256 public totalPlacements;

    mapping(uint256 => uint256) private _colorWords;
    mapping(uint256 => uint256) private _countWords;
    mapping(address => Player) public players;
    address[] private _playerList;

    event PixelPlaced(
        uint256 indexed pixelId, address indexed painter, uint8 color, uint16 overwrites, uint256 price
    );
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OutOfBounds();
    error InvalidColor();
    error InsufficientPayment(uint256 required, uint256 sent);
    error CooldownActive(uint256 readyAt);
    error NotOwner();
    error TransferFailed();
    error BadConfig();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 width_, uint256 height_, uint256 basePrice_, uint256 priceIncrement_, uint256 cooldown_) {
        if (width_ == 0 || height_ == 0 || width_ > 4096 || height_ > 4096) revert BadConfig();
        if ((width_ * height_) % PIXELS_PER_COLOR_WORD != 0) revert BadConfig();
        width = width_;
        height = height_;
        basePrice = basePrice_;
        priceIncrement = priceIncrement_;
        cooldown = cooldown_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- writes

    function placePixel(uint256 x, uint256 y, uint8 color) external payable {
        if (x >= width || y >= height) revert OutOfBounds();
        if (color >= COLORS) revert InvalidColor();

        Player memory p = players[msg.sender];
        if (p.placed != 0 && block.timestamp < uint256(p.lastPlacedAt) + cooldown) {
            revert CooldownActive(uint256(p.lastPlacedAt) + cooldown);
        }

        uint256 id = y * width + x;
        uint16 count = _countOf(id);
        uint256 price = basePrice + priceIncrement * count;
        if (msg.value < price) revert InsufficientPayment(price, msg.value);

        _setColor(id, color);
        if (count < type(uint16).max) _setCount(id, count + 1);

        if (p.placed == 0) _playerList.push(msg.sender);
        players[msg.sender] = Player({
            lastPlacedAt: uint64(block.timestamp),
            placed: p.placed + 1,
            spent: p.spent + uint128(price)
        });
        unchecked {
            ++totalPlacements;
        }

        emit PixelPlaced(id, msg.sender, color, count, price);

        // Refund overpayment (lets the frontend send a small buffer if the price moves under it).
        uint256 excess = msg.value - price;
        if (excess != 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            if (!ok) revert TransferFailed();
        }
    }

    function withdraw(address payable to) external onlyOwner {
        uint256 amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------- reads

    function colorOf(uint256 x, uint256 y) external view returns (uint8) {
        if (x >= width || y >= height) revert OutOfBounds();
        uint256 id = y * width + x;
        return uint8((_colorWords[id / PIXELS_PER_COLOR_WORD] >> ((id % PIXELS_PER_COLOR_WORD) * 4)) & 0xF);
    }

    function overwritesOf(uint256 x, uint256 y) external view returns (uint16) {
        if (x >= width || y >= height) revert OutOfBounds();
        return _countOf(y * width + x);
    }

    function priceOf(uint256 x, uint256 y) external view returns (uint256) {
        if (x >= width || y >= height) revert OutOfBounds();
        return basePrice + priceIncrement * _countOf(y * width + x);
    }

    /// @notice Seconds until `who` can place again (0 if ready).
    function cooldownRemaining(address who) external view returns (uint256) {
        Player memory p = players[who];
        if (p.placed == 0) return 0;
        uint256 readyAt = uint256(p.lastPlacedAt) + cooldown;
        return block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
    }

    /// @notice Canvas words [from, from+count), packed 4 bits per pixel: pixel i is at bits
    ///         [(i%64)*4, +4) of word i/64. There are width*height/64 words; the range is clamped to that.
    function getCanvas(uint256 from, uint256 count) external view returns (uint256[] memory words) {
        words = _range(_colorWords, from, count, (width * height) / PIXELS_PER_COLOR_WORD);
    }

    /// @notice Overwrite-count words [from, from+count), packed 16 bits per pixel, pixel i in word i/16.
    function getOverwrites(uint256 from, uint256 count) external view returns (uint256[] memory words) {
        words = _range(_countWords, from, count, (width * height + PIXELS_PER_COUNT_WORD - 1) / PIXELS_PER_COUNT_WORD);
    }

    function playerCount() external view returns (uint256) {
        return _playerList.length;
    }

    /// @notice Paginated player list with stats, for the leaderboard.
    function getPlayers(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory addrs, Player[] memory stats)
    {
        uint256 len = _playerList.length;
        if (offset >= len) return (new address[](0), new Player[](0));
        uint256 end = offset + limit > len ? len : offset + limit;
        addrs = new address[](end - offset);
        stats = new Player[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            addrs[i - offset] = _playerList[i];
            stats[i - offset] = players[_playerList[i]];
        }
    }

    // ---------------------------------------------------------------- internal

    function _range(mapping(uint256 => uint256) storage m, uint256 from, uint256 count, uint256 total)
        private
        view
        returns (uint256[] memory words)
    {
        if (from >= total) return new uint256[](0);
        uint256 end = count > total - from ? total : from + count;
        words = new uint256[](end - from);
        for (uint256 i = from; i < end; ++i) {
            words[i - from] = m[i];
        }
    }

    function _countOf(uint256 id) private view returns (uint16) {
        return uint16(_countWords[id / PIXELS_PER_COUNT_WORD] >> ((id % PIXELS_PER_COUNT_WORD) * 16));
    }

    function _setColor(uint256 id, uint8 color) private {
        uint256 w = id / PIXELS_PER_COLOR_WORD;
        uint256 shift = (id % PIXELS_PER_COLOR_WORD) * 4;
        _colorWords[w] = (_colorWords[w] & ~(uint256(0xF) << shift)) | (uint256(color) << shift);
    }

    function _setCount(uint256 id, uint16 count) private {
        uint256 w = id / PIXELS_PER_COUNT_WORD;
        uint256 shift = (id % PIXELS_PER_COUNT_WORD) * 16;
        _countWords[w] = (_countWords[w] & ~(uint256(0xFFFF) << shift)) | (uint256(count) << shift);
    }
}
