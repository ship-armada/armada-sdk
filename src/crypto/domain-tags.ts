// ABOUTME: Single registry of HKDF/AEAD domain-separation tags (SPEC §6.2) — every subkey derivation
// ABOUTME: sources its salt/info here so two schemes can never silently collide on the same tag.

/**
 * All domain-separation tags used across the SDK's key derivations, in ONE place so a reviewer can
 * confirm at a glance that no two derivations share a (salt, info) pair. New derivations (claim-seed,
 * backup-file, …) MUST add their tags here rather than inline, per SPEC §6.2.
 */
export const DOMAIN_TAGS = {
  /** At-rest storage-key derivation (§4.3). `info` for the rootSecret path; `infoWallet` for the
   *  per-wallet path keyed by the viewing private key. */
  storage: {
    salt: 'armada/sdk/storage/v1',
    info: 'at-rest-encryption',
    infoWallet: 'at-rest-encryption/wallet-v1',
  },
  // claimSeed: { salt: 'armada/claim-seed/v1' }  // reserved (§6.2) — lands with claimable payments.
} as const;
