# Upstream nullable IP-address role tracking

Local E2E uses the focused upstream fix, but upstream submission is separate.

| Item                                                              | State (checked 2026-09-04)                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [#23124](https://github.com/netbox-community/netbox/issues/23124) | **Closed**, unassigned. GitHub Actions closed it because it was not submitted with an issue form.                                  |
| [#23123](https://github.com/netbox-community/netbox/issues/23123) | **Closed**, unassigned. Same browser-form closure.                                                                                 |
| Fork branch                                                       | [`fix/nullable-ipaddress-role-response`](https://github.com/chris-cald/netbox/tree/fix/nullable-ipaddress-role-response)           |
| Fork commit                                                       | [`635361b87d67b70e9338fa141e8ad932c2b2fba4`](https://github.com/chris-cald/netbox/commit/635361b87d67b70e9338fa141e8ad932c2b2fba4) |
| Pull request                                                      | Not opened.                                                                                                                        |

## Submission blocker and next gate

The GitHub CLI-created issues were auto-closed: upstream requires its browser
issue form. Reopen the report through the browser form first. Do not open a
pull request until that issue is open **and** assigned to a maintainer, unless
maintainer status is independently verified. That assignment/maintainer check
is the next gate.

The local image is only an E2E unblocker. It is built from the fork commit and
must not be described as an upstream NetBox release or as proof that unpatched
v4.6.7 passes.
