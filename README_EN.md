# aotulinuxdo

English · [简体中文](README.md)

A local Google Chrome reading helper for [Linux.do](https://linux.do/), migrated from an enhanced userscript. Uses Manifest V3; no userscript manager or build step is required.

## Features

- Click the extension icon to open Linux.do in a new tab.
- Automatic reading, smooth scrolling, pauses, elapsed-time display and reading history.
- Optional automatic likes with mode and minimum-like-count controls.
- Pointer/Mouse events for page controls; no `chrome.debugger` permission or hardware-trusted mouse simulation.
- Connect account conditions for Lv2+, with actual and target levels kept separate.
- Compact emoji account panel with thin progress bars, update times and daily changes. Comparisons require a saved previous-day record with matching levels and statistical scope.
- Failed refreshes retain the same account's last successful data. Caches are account-scoped; HTTP 429 starts a cooldown for level requests.

## Requirements and Installation

Use Google Chrome with Manifest V3 support and a signed-in Linux.do account.

1. Click **Code → Download ZIP** in this repository and extract it to a permanent folder.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode** and click **Load unpacked**.
4. Select the folder containing `manifest.json`, not its parent or the ZIP file.
5. Open and refresh [Linux.do](https://linux.do/). The helper panel indicates successful loading.

After replacing local source files, click **Reload** on the extensions page, then refresh the forum. No Node.js, API key or manual configuration-file edits are required.

## Configuration and Use

1. Adjust reading speed, scope and limits in **Settings**.
2. Set the like mode and minimum like count in **Reading**. The minimum defaults to `5`; enable automatic likes only if desired.
3. Click **Start reading** to see status and elapsed time. Stop ends the current reading session.
4. View conditions and timestamps in **Account**; use **Refresh** for a manual update.
5. The icon-only GitHub link in the panel header opens this repository.

### Recent-100-Day Counter

The counter reads the current value in the account's posts-read row: `18142/20000` supplies `18142`, not the requirement on the right.

| Event | Updates the counter |
| --- | --- |
| Start reading | Yes |
| Finish or manually stop | Yes, after a short delay |
| Click the counter | Yes |
| Automatic navigation, page reload or extension reinjection during reading | No; retains the cached counter |

Lv0/Lv1 conditions use cumulative forum statistics; Lv2+ uses Connect conditions. The account panel labels a period as recent 100 days only when the source page explicitly specifies it.

### Background Connect Tab

When new data is required, the extension reuses a [Connect account page](https://connect.linux.do/) in the reading window or creates an inactive tab there. It does not deliberately switch tabs. After a successful read, it closes only the tab created for that request if it is still inactive and on Connect.

Existing tabs, tabs activated by the user, and tabs navigated elsewhere are preserved. Sign-in, verification and read failures leave the page available for troubleshooting. Valid cached data renders immediately; automatic reading navigation does not reopen Connect.

## Troubleshooting

- **403, sign-in or verification required:** Open the preserved Connect tab, finish sign-in or verification with the same account as the forum, then refresh the helper's account panel. Verification is not bypassed.
- **429:** Wait for the level-request cooldown; avoid repeated refreshes.
- **No daily change marker:** A comparable saved record from yesterday is required. Missing values are not treated as zero.
- **Old UI:** Reload the extension and refresh the forum. Refresh any existing Connect tab too.
- **Unavailable fields:** Website markup may have changed. Check the account page and refresh manually; cached values are not live results.

## Permissions and Structure

`storage` saves settings and state. Site access is limited to `linux.do`, `idcflare.com` and `connect.linux.do`. Connect snapshots pass through internal extension messages; no cloud sync, leaderboard or additional account service is integrated.

```text
background/service-worker.js  Background requests and temporary tab lifecycle
content/assistant.js          UI, reading and likes
content/account-parser.js     Shared account parser
content/connect-reader.js     Connect page reader
content/bridge.js             Userscript compatibility and page interactions
lib/html2canvas.min.js        Bundled screenshot dependency
linux.do.png                 Extension icon
manifest.json                Extension configuration
```

## Version 2.6.6

Unified live/cached account rendering, corrected level detection and improved parsing; compact emoji UI and daily comparisons; automatic cleanup of successfully read temporary background Connect tabs.

Fixed first-post ID detection for automatic likes: reads nested post attributes and reaction counters, distinguishes floor numbers from global post IDs, waits for readiness, never substitutes an arbitrary reply, and rechecks the page and first post before clicking.

First-post detection prioritizes verified `article#post_1[data-post-id]` markup. Offline parsing regression tests passed against user-supplied real HTML; live browser clicking remains unverified. Reaction totals can include multiple emoji types rather than heart reactions alone.

The shared parser independently implements ideas informed by [LDStatusPro](https://github.com/caigg188/LDStatusPro). The main script retains the original project's MIT License declaration; `html2canvas` follows its own license.

Automated access may be affected by website rules, rate limits and markup changes. Use reasonable speeds and limits, and follow the website's terms and community rules.
