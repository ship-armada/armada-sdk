// ABOUTME: Privacy nudges entry: local-only checks over a planned action + the wallet's own history
// ABOUTME: that warn about privacy-reducing habits and suggest a one-click fix.

export {
  checkPrivacy,
  suggestSplit,
  formatAmount,
  DEFAULT_PRIVACY_THRESHOLDS,
} from './check';
export type {
  PrivacyActionKind,
  PlannedPrivacyAction,
  PrivacyThresholds,
  PrivacyContext,
  PrivacyCheckId,
  PrivacyFix,
  PrivacyWarningLevel,
  PrivacyWarning,
  PrivacyReport,
} from './check';
