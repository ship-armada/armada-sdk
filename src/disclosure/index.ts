// ABOUTME: Selective-disclosure entry (ADR-0020, armada-laconic engineering/16) — build and check a
// ABOUTME: voluntary, off-chain chain-of-custody package over the pool and armada-nitro hub channels.

// Package format + constants.
export {
  SNARK_SCALAR_FIELD,
  SHIELD_ALLOCATION_TYPE,
  DISCLOSURE_PACKAGE_VERSION,
} from './types';
export type {
  HopKind,
  DisclosureDomain,
  DisclosureEndpoint,
  DisclosureStatement,
  EndpointSignature,
  NoteOpening,
  DisclosureProofEntry,
  CommitmentLocation,
  Hop,
  Hop1,
  Hop2,
  Hop3,
  Hop4,
  Hop5,
  Hop6,
  Hop7,
  AttributionClaim,
  SignedChannelState,
  ChannelStatesEntry,
  DisclosurePackage,
} from './types';

// Statement crypto — EIP-712 domain/types, hop hash, statementHash field, signature verification.
export {
  DISCLOSURE_EIP712_DOMAIN_NAME,
  DISCLOSURE_EIP712_DOMAIN_VERSION,
  DISCLOSURE_EIP712_TYPES,
  eip712Domain,
  statementMessage,
  hashHops,
  statementDigest,
  statementHashField,
  verifyEndpointSignature,
} from './statement';

// Circuit adapter — witness formatting and public signals. The Node artifact loader is on
// `@armada/sdk/node` (`loadDisclosureArtifacts`).
export {
  DISCLOSURE_PUBLIC_SIGNAL_NAMES,
  formatDisclosureInput,
  disclosurePublicSignals,
} from './circuit';
export type { DisclosureCircuitInput, DisclosureSigningKeys } from './circuit';

// go-nitro state-channel primitives (H7) — channel id, state hash, ECDSA signer recovery.
export { getChannelId, hashNitroState, recoverNitroSigner, participantDestination } from './nitro';
export type {
  NitroAllocation,
  NitroAssetMetadata,
  NitroSingleAssetExit,
  NitroFixedPart,
  NitroVariablePart,
} from './nitro';

// Builder.
export { buildDisclosurePackage } from './builder';
export type {
  BuildDisclosureParams,
  BuilderOpening,
  BuilderSpend,
  EndpointSigner,
  EndpointSignRequest,
} from './builder';

// Chain-event source.
export { InMemoryDisclosureChainSource } from './chain-source';
export type {
  DisclosureChainSource,
  DisclosureChainData,
  EventScope,
  ScopedShieldCommitment,
  ScopedTransactCommitment,
  ScopedNullifier,
  ScopedUnshield,
  HubDepositRecord,
  HubAllocation,
  HubFinalizedOutcomeRecord,
  HubSignatureRequest,
  NitroSignature,
} from './chain-source';

// Checker.
export { checkDisclosurePackage } from './checker';
export type {
  CheckDisclosureParams,
  DisclosureCheckResult,
  DisclosureCheckFailure,
  DisclosureCheckName,
  DisclosureLearned,
  AllocationChange,
} from './checker';

// Serialization.
export { serializeDisclosurePackage, parseDisclosurePackage } from './serialize';
