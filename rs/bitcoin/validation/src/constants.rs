use std::collections::HashMap;

use bitcoin::{hashes::hex::FromHex, util::uint::Uint256, BlockHash, Network};

use crate::BlockHeight;

/// Expected number of blocks for 2 weeks (2_016).
pub const DIFFICULTY_ADJUSTMENT_INTERVAL: BlockHeight = 6 * 24 * 14;

/// Needed to help test check for the 20 minute testnet/regtest rule
pub const TEN_MINUTES: u32 = 60 * 10;

/// Bitcoin mainnet checkpoints
#[rustfmt::skip]
const BITCOIN: &[(BlockHeight, &str)] = &[
    (11111, "0000000069e244f73d78e8fd29ba2fd2ed618bd6fa2ee92559f542fdb26e7c1d",),
    (33333, "000000002dd5588a74784eaa7ab0507a18ad16a236e7b1ce69f00d7ddfb5d0a6",),
    (74000, "0000000000573993a3c9e41ce34471c079dcf5f52a0e824a81e7f953b8661a20",),
    (105000, "00000000000291ce28027faea320c8d2b054b2e0fe44a773f3eefb151d6bdc97",),
    (134444, "00000000000005b12ffd4cd315cd34ffd4a594f430ac814c91184a0d42d2b0fe",),
    (168000, "000000000000099e61ea72015e79632f216fe6cb33d7899acb35b75c8303b763",),
    (193000, "000000000000059f452a5f7340de6682a977387c17010ff6e6c3bd83ca8b1317",),
    (210000, "000000000000048b95347e83192f69cf0366076336c639f9b7228e9ba171342e",),
    (216116, "00000000000001b4f4b433e81ee46494af945cf96014816a4e2370f11b23df4e",),
    (225430, "00000000000001c108384350f74090433e7fcf79a606b8e797f065b130575932",),
    (250000, "000000000000003887df1f29024b06fc2200b55f8af8f35453d7be294df2d214",),
    (279000, "0000000000000001ae8c72a0b0c301f67e3afca10e819efa9041e458e9bd7e40",),
    (295000, "00000000000000004d9b4ef50f0f9d686fd69db2e03af35a100370c64632a983",),
];

/// Bitcoin testnet checkpoints
#[rustfmt::skip]
const TESTNET: &[(BlockHeight, &str)] = &[
    (546, "000000002a936ca763904c3c35fce2f3556c559c0214345d31b1bcebf76acb70")
];

/// Bitcoin mainnet maximum target value
const BITCOIN_MAX_TARGET: Uint256 = Uint256([
    0x0000000000000000,
    0x0000000000000000,
    0x0000000000000000,
    0x00000000ffff0000,
]);

/// Bitcoin testnet maximum target value
const TESTNET_MAX_TARGET: Uint256 = Uint256([
    0x0000000000000000,
    0x0000000000000000,
    0x0000000000000000,
    0x00000000ffff0000,
]);

/// Bitcoin regtest maximum target value
const REGTEST_MAX_TARGET: Uint256 = Uint256([
    0x0000000000000000,
    0x0000000000000000,
    0x0000000000000000,
    0x7fffff0000000000,
]);

/// Bitcoin signet maximum target value
const SIGNET_MAX_TARGET: Uint256 = Uint256([
    0x0000000000000000u64,
    0x0000000000000000u64,
    0x0000000000000000u64,
    0x00000377ae000000u64,
]);

/// Returns the maximum difficulty target depending on the network
pub fn max_target(network: &Network) -> Uint256 {
    match network {
        Network::Bitcoin => BITCOIN_MAX_TARGET,
        Network::Testnet => TESTNET_MAX_TARGET,
        Network::Regtest => REGTEST_MAX_TARGET,
        Network::Signet => SIGNET_MAX_TARGET,
    }
}

/// Returns false iff PoW difficulty level of blocks can be
/// readjusted in the network after a fixed time interval.
pub fn no_pow_retargeting(network: &Network) -> bool {
    match network {
        Network::Bitcoin | Network::Testnet | Network::Signet => false,
        Network::Regtest => true,
    }
}

/// Returns the PoW limit bits of the bitcoin network
pub fn pow_limit_bits(network: &Network) -> u32 {
    match network {
        Network::Bitcoin => 0x1d00ffff,
        Network::Testnet => 0x1d00ffff,
        Network::Regtest => 0x207fffff,
        Network::Signet => 0x1e0377ae,
    }
}

/// Checkpoints used to validate blocks at certain heights.
pub fn checkpoints(network: &Network) -> HashMap<BlockHeight, BlockHash> {
    let points = match network {
        Network::Bitcoin => BITCOIN,
        Network::Testnet => TESTNET,
        Network::Signet => &[],
        Network::Regtest => &[],
    };
    points
        .iter()
        .cloned()
        .map(|(height, hash)| {
            let hash = BlockHash::from_hex(hash).expect("Programmer error: invalid hash");
            (height, hash)
        })
        .collect()
}

#[cfg(test)]
pub mod test {

    /// Mainnet 000000000000000000063108ecc1f03f7fd1481eb20f97307d532a612bc97f04
    pub const MAINNET_HEADER_586656: &str ="00008020cff0e07ab39db0f31d4ded81ba2339173155b9c57839110000000000000000007a2d75dce5981ec421a54df706d3d407f66dc9170f1e0d6e48ed1e8a1cad7724e9ed365d083a1f17bc43b10a";
    /// Mainnet 0000000000000000000d37dfef7fe1c7bd22c893dbe4a94272c8cf556e40be99
    pub const MAINNET_HEADER_705600: &str = "0400a0205849eed80b320273a73d39933c0360e127d15036a69d020000000000000000006cc2504814505bb6863d960599c1d1f76a4768090ac15b0ad5172f5a5cd918a155d86d6108040e175daab79e";
    /// Mainnet 0000000000000000000567617f2101a979d04cff2572a081aa5f29e30800ab75
    pub const MAINNET_HEADER_705601: &str = "04e0002099be406e55cfc87242a9e4db93c822bdc7e17fefdf370d000000000000000000eba036bca22654014f363f3019d0f08b3cdf6b2747ab57eff2e6dc1da266bc0392d96d6108040e176c6624cd";
    /// Mainnet 00000000000000000001eea12c0de75000c2546da22f7bf42d805c1d2769b6ef
    pub const MAINNET_HEADER_705602: &str = "0400202075ab0008e3295faa81a07225ff4cd079a901217f616705000000000000000000c027a2615b11b4c75afc9e42d1db135d7124338c1f556f6a14d1257a3bd103a5f4dd6d6108040e1745d26934";

    /// Testnet 00000000000000e23bb091a0046e6c73160db0a71aa052c20b10ff7de7554f97
    pub const TESTNET_HEADER_2132555: &str = "004000200e1ff99438666c67c649def743fb82117537c2017bcc6ad617000000000000007fa40cf82bf224909e3174281a57af2eb3a4a2a961d33f50ec0772c1221c9e61ddfdc061ffff001a64526636";
    /// Testnet 00000000383cd7fff4692410ccd9bd6201790043bb41b93bacb21e9b85620767
    pub const TESTNET_HEADER_2132556: &str = "00000020974f55e77dff100bc252a01aa7b00d16736c6e04a091b03be200000000000000c44f2d69fc200c4a2211885000b6b67512f42c1bec550f3754e103b6c4046e05a202c161ffff001d09ec1bc4";
}