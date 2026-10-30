// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice ERC-1404 style transfer-restriction codes shared by the token and the exchange.
/// Codes are grouped so the exchange can tell who is at fault when a match fails:
///   1-2, 7  : market-wide (closed, paused, lock-up)
///   3-6     : sender side
///   8-14    : recipient side
library Restrictions {
    uint8 internal constant OK = 0;
    uint8 internal constant CLOSED = 1;
    uint8 internal constant PAUSED = 2;
    uint8 internal constant SENDER_FROZEN = 3;
    uint8 internal constant SENDER_NOT_VERIFIED = 4;
    uint8 internal constant INSUFFICIENT_UNLOCKED = 5;
    uint8 internal constant INSUFFICIENT_LOCKED = 6;
    uint8 internal constant LOCKUP = 7;
    uint8 internal constant RECIPIENT_FROZEN = 8;
    uint8 internal constant RECIPIENT_NOT_VERIFIED = 9;
    uint8 internal constant NOT_ACCREDITED = 10;
    uint8 internal constant COUNTRY_BLOCKED = 11;
    uint8 internal constant HOLDER_LIMIT = 12;
    uint8 internal constant HOLDING_CAP = 13;
    uint8 internal constant SUPPLY_CAP = 14;

    function isSenderSide(uint8 code) internal pure returns (bool) {
        return code >= SENDER_FROZEN && code <= INSUFFICIENT_LOCKED;
    }

    function isRecipientSide(uint8 code) internal pure returns (bool) {
        return code >= RECIPIENT_FROZEN && code <= SUPPLY_CAP;
    }

    function message(uint8 code) internal pure returns (string memory) {
        if (code == OK) return "No restriction";
        if (code == CLOSED) return "Property is closed";
        if (code == PAUSED) return "Token is paused";
        if (code == SENDER_FROZEN) return "Sender is frozen";
        if (code == SENDER_NOT_VERIFIED) return "Sender is not KYC verified";
        if (code == INSUFFICIENT_UNLOCKED) return "Insufficient unlocked balance";
        if (code == INSUFFICIENT_LOCKED) return "Insufficient locked balance";
        if (code == LOCKUP) return "Tokens are in lock-up period";
        if (code == RECIPIENT_FROZEN) return "Recipient is frozen";
        if (code == RECIPIENT_NOT_VERIFIED) return "Recipient is not KYC verified";
        if (code == NOT_ACCREDITED) return "Recipient is not accredited";
        if (code == COUNTRY_BLOCKED) return "Recipient jurisdiction is blocked";
        if (code == HOLDER_LIMIT) return "Maximum number of holders reached";
        if (code == HOLDING_CAP) return "Recipient would exceed holding cap";
        if (code == SUPPLY_CAP) return "Exceeds maximum supply";
        return "Unknown restriction";
    }
}
