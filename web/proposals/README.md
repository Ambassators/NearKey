# NearKey theme proposals

Run `npm run proposals` from the repository root, then open http://localhost:4173.

Five separate responsive design pages are available through the comparison page:

1. **Sage** — approachable forest green and mint.
2. **Signal** — dark, precise, connection-focused.
3. **Paper** — warm editorial serif and terracotta.
4. **Workspace** — structured white and blue productivity UI.
5. **Studio** — bold black typography and orange accents.

Use the screen selector to compare sign-in, phone setup/verification, and the dashboard. “Open theme” opens the selected page at full browser width. Each prototype has local navigation, an Add app preview, and phone replacement explanation. These are presentation prototypes with sample data; they do not perform authentication, enroll phones, or contact app URLs.

The production frontend and authentication flow remain in `web/index.html` and `web/app.mjs`. Choose a theme before applying it to those files.
