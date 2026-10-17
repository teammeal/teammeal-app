/* Where the Team Meal backend lives. It is the site's own /api (a Cloudflare function with a Cloudflare database).
   For local testing a page can set window.TEAMMEAL_API before this file loads. */
window.TEAMMEAL_API = window.TEAMMEAL_API || "/api";
