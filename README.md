# teammeal-app

Team Meal (teammeal.app): one link, everyone picks their own food, one clean order for the restaurant.

- `index.html` coming-soon page
- `setup.html` organizer setup (team, roster, menu)
- `order.html` the page families use to order
- `organizer.html` organizer view: kitchen tickets, who is missing, edit or remove orders
- `functions/api.js` the backend (Cloudflare Pages Function, database `DB` = D1 database "teammeal")
- `dev/` local tests: `node dev/test-api.js`, `node dev/server.js`

Deploys automatically on every push to main. No Google services.
