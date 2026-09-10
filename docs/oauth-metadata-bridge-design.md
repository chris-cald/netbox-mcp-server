# Superseded: OAuth metadata bridge design

Do not implement this bridge. Authentik `>=2025.8` provides the RFC 8414 authorization-server
metadata endpoint needed for path-bearing issuers, so an Authentik upgrade is the correct
protocol fix. See [OAuth metadata compatibility prerequisite](oauth-metadata-compatibility.md).

A metadata bridge would also not establish ChatGPT compatibility: CIMD, DCR, and predefined
client flows remain separate unproven requirements until an end-to-end test succeeds.
