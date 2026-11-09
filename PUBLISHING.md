# Publishing to kolkataffl.com

The dashboard is a static site that GitHub Pages rebuilds every Tuesday. It is styled to match
kolkataffl.com (Oswald + Open Sans, black bar, #ff5252 accent) and links back to the main site.

## For Zanna: point a subdomain at it

kolkataffl.com is a Google Site; the dashboard lives at **stats.kolkataffl.com**.

1. Where the kolkataffl.com domain's DNS is managed, add one record:

   | Type  | Host / Name | Value                       | TTL     |
   |-------|-------------|-----------------------------|---------|
   | CNAME | `stats`     | `jwillowest.github.io` | default |

2. Tell the repo owner when it's saved. They set `stats.kolkataffl.com` under repo
   Settings > Pages > Custom domain and tick **Enforce HTTPS** once GitHub issues the certificate
   (usually under an hour).
3. On the Google Site, add a nav link to `https://stats.kolkataffl.com`, or embed it on a page:
   Insert > Embed > By URL > `https://stats.kolkataffl.com` > Whole page.

Nothing else on the main site changes. The `www` and root records stay pointed at Google Sites.
