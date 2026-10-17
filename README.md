# teammeal-app

Team Meal (teammeal.app): one link, everyone picks their own food, one clean order for the restaurant.

The public site is the `public/` folder only. `functions/` and `dev/` are never served.

- `public/index.html` coming-soon page with the wait list
- `public/setup.html` organizer setup (team, roster, menu)
- `public/order.html` the page families use to order
- `public/organizer.html` organizer view: kitchen tickets, who is missing, edit or remove orders
- `public/admin.html` owner page: wait list and team counts (private link)
- `functions/api.js` the backend (Cloudflare Pages Function; database binding `DB` = D1 database "teammeal")
- `dev/` local tests: `node dev/test-api.js`, `node dev/server.js`

Deploys automatically on every push to main. Cloudflare build output directory: `public`. No Google services.
