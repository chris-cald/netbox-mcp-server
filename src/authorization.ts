/** Select the NetBox authentication scheme from a complete token value. */
export function netBoxAuthorization(token: string): string {
  // NetBox v2 tokens are nbt_<identifier>.<secret>; an incomplete lookalike
  // remains a legacy Token credential rather than changing its meaning.
  return /^nbt_[^.\s]+\.[^.\s]+$/.test(token) ? `Bearer ${token}` : `Token ${token}`;
}
