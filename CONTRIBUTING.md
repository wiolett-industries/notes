# Contributing to Notes

Thanks for helping improve Notes. Small, focused changes are welcome.

## Before starting

Search existing issues and pull requests. For a large feature or a change to the
encryption protocol, describe the problem and proposed behavior in an issue first.
Bug reports should include browser/OS versions, clear reproduction steps, and
whether the board is personal, shared, or public. Use a disposable board to
reproduce problems; never attach real access keys, session cookies, private
screenshots, or decrypted user data.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Development

Use Node.js 24.13 or newer and npm:

```sh
npm ci
npm run dev
```

The frontend runs on `http://localhost:5173`; the API and WebSocket server run on
port 3001. See the [README](README.md#development) for configuration.

Before opening a pull request:

```sh
npm run typecheck
npm run build
npm test
```

For browser changes, check the affected flow in both languages and themes.
The Playwright suite is available through `npm run test:e2e`; its browser binary
can be installed with `npx playwright install chromium`.

## Keep changes focused

- Reuse the existing UI components and CSS variables.
- Keep English and Russian UI translations in sync. Never translate user content.
- Use Lucide icons instead of introducing a separate icon set.
- Keep passkey PRF output and access-key seeds out of network payloads and logs.
- Preserve domain-separated encryption contexts and backwards compatibility.
- Cover behavior changes with the smallest useful check, especially permissions,
  file cleanup, and encryption boundaries.
- Explain what changed, why, and how you verified it in the pull request.

Contributions are licensed under the repository's [MIT License](LICENSE).
