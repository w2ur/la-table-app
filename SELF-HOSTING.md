# Self-hosting La Table

[English](#english) · [Français](#français)

<a id="english"></a>

## English

This guide puts your own copy of La Table on your own Cloudflare account: the app, its database, its login, its deploys, and, if you want it, its demo. It assumes you are at ease with a terminal, git and a web dashboard. Back to the [README](README.md).

### What protects the app

Cloudflare Access is the protection, nothing else. The app answers on its Worker's own address, `https://la-table.<your-subdomain>.workers.dev`, and Access stands in front of every path of it: a visitor without a session gets the Access login page, which sends a one-time code only to the email addresses you list. The address is not a secret, and neither are the account id, the database id, the Access team domain or the AUD tag: they sit in your repository's configuration in plain text, and your repository can be public. The secrets are your Cloudflare login and the two service tokens' client secrets, and none of them is ever written into the repository. The Worker itself holds no secret, and the deploy refuses to run when one has been added to it.

### Requirements

- A Cloudflare account, with two-factor authentication turned on (Cloudflare's Zero Trust setup page recommends it). Everything here fits the free tiers: Workers Free, D1, Workers Builds, and Cloudflare Zero Trust Free for Access. The Zero Trust onboarding asks for payment details even on the Free plan, and does not charge them. Workers Builds Free allows 3,000 build minutes a month, one build at a time, and 20 minutes per build (Cloudflare's limits page, 2026-11-15); a deploy of the app takes a few minutes.
- A GitHub or GitLab account, for the repository Workers Builds deploys from.
- Node 24 (`.nvmrc`; `package.json` refuses another major version) and git. With nvm or fnm, `nvm install` or `fnm use --install-if-missing` in the repository reads `.nvmrc`; otherwise take the v24 installer from https://nodejs.org/en/download.
- Which machine:
  - **Workers Builds is the deploy path, and it is the same from any OS:** you push to `main`, Cloudflare builds and deploys.
  - **The planning CLI** (`npm run plan -- …`) runs on any OS: on macOS it reads its token from the login keychain, elsewhere from two environment variables (below).
  - **The laptop deploy (`npm run deploy`) and the live probes (`npm run probe:live`, `npm run probe:burst`) are keychain-only, so macOS only.** Off macOS, deploy through Workers Builds and check the address with `curl` as shown below.
  - `npm run backup` and `npm run restore-drill` run wrangler with your `wrangler login`; they have only been run on macOS.

Dashboard labels in this guide were checked against Cloudflare's documentation on 2026-11-15, not against a live dashboard. Cloudflare renames them now and then; when a label differs, the documentation pages linked in each step are authoritative.

### Step 1. Get the code into your own repository

```bash
git clone https://github.com/w2ur/la-table-app.git la-table
cd la-table
git remote rename origin upstream        # the public mirror, for updates later
# create an empty repository on GitHub or GitLab, then:
git remote add origin <your repository's URL>
git push -u origin main
npm ci
npx wrangler login                       # opens a browser on this machine; wrangler keeps an OAuth login
npx wrangler whoami                      # prints your account id
```

`wrangler login` needs a browser on the same machine. On a headless or remote machine, create an API token in the dashboard (My Profile › API Tokens) and export it as `CLOUDFLARE_API_TOKEN` instead; wrangler reads it, and the deploy's and backup's wrangler steps pass it through (the backup with a token has not been tried).

Your account's workers.dev subdomain: **Workers & Pages** in the dashboard shows **Your subdomain** (Change next to it). If none exists yet, pick one there now: `DEFAULT_URL` in step 2 needs it, and step 4's `wrangler deploy` would otherwise stop to ask for one. It is the `<your-subdomain>` in every address below.

### Step 2. The values to replace

Every value below belongs to the mirror's owner and must become yours. Keep everything else as it is: the Worker must stay named `la-table` and the database `la-table` (the deploy gate refuses another name), and the demo Worker `la-table-demo`.

<!-- replace-values -->
| What | Value in the mirror | Files that hold it |
|---|---|---|
| Cloudflare account id (`npx wrangler whoami`) | `44513f9fd94c38330fc5ca98603adf15` | `wrangler.jsonc`, `wrangler.demo.jsonc`, `probes/placeholder/wrangler.jsonc`, `probes/d1-limit/wrangler.jsonc` |
| D1 database id (step 3) | `ca55d47f-86a2-40a0-bc1d-a07715071804` | `wrangler.jsonc` |
| Access team domain (step 5) | `william-445.cloudflareaccess.com` | `wrangler.jsonc` |
| Access application's AUD tag (step 5) | `6e02bad1e8d730288705b85a6ff3c01332f1b51685e9ead3064971c7634cb7c3` | `wrangler.jsonc`, `.gitleaks.toml` |
| The app's address, `DEFAULT_URL`: `https://la-table.<your-subdomain>.workers.dev`, nothing after the host | `https://la-table.william-445.workers.dev` | `src/cli/client.ts` |
| `MAIN_REMOTE`: your repository's HTTPS clone URL, where a laptop deploy reads `main` | `https://github.com/w2ur/la-table.git` | `scripts/deploy-ci.ts` |
<!-- /replace-values -->

The values do not all exist yet. Fill now the account id, `DEFAULT_URL` and `MAIN_REMOTE`; the D1 id after step 3; the team domain and the AUD after step 5. To fill one, find and replace its "Value in the mirror" with yours in each listed file (an editor's find-and-replace, or `sed`), and touch nothing else on the line.

Notes on each file:

- `wrangler.jsonc` is the app. `wrangler.demo.jsonc` is the demo, whose account must be the app's (its deploy gate checks it). `probes/placeholder/wrangler.jsonc` is the stand-in Worker of step 4. `probes/d1-limit/wrangler.jsonc` serves only a one-off measurement you will probably never run, but the suite reads it, so change it too.
- `.gitleaks.toml` matters only if you run gitleaks on your repository: it allowlists the AUD tag by exact value, inside a regular expression, so a new AUD needs the new value there and no other character changed.
- `DEFAULT_URL` is the only address the CLI, the probes and the deploy send a service token to, and the deploy checks it is on your account's own workers.dev subdomain.

`node scripts/self-hosting-values.ts --remaining` lists every value of this table still in its file (exit 1 while one is, 0 once none is). It is the check, not this table: run it after each fill to see what is left, expect it to pass only at step 7, and run it again after every update from the mirror.

### Step 3. The database

```bash
npx wrangler d1 create la-table
```

Put the `database_id` it prints into `wrangler.jsonc`, in the existing `d1_databases` entry. If wrangler offers to add the database to the configuration itself, say no, or check afterwards that `d1_databases` still holds a single entry: the deploy refuses a second one. You do not apply the migrations by hand: every deploy prints a D1 Time Travel bookmark (the restore point), applies the pending migrations in `migrations/` remotely, and checks none is left.

### Step 4. A placeholder under the Worker's name

Access is set on an existing Worker, and the real deploy refuses to run until it sees Access in front of the address. So the first thing ever deployed as `la-table` is a stand-in with no data and no binding, which answers 503 to everything:

```bash
npx wrangler deploy -c probes/placeholder/wrangler.jsonc
```

This is the only time `la-table` is deployed outside `npm run deploy:ci`. Until step 5 is done its address answers anyone, which is harmless: it holds nothing.

### Step 5. Cloudflare Access

Zero Trust lives at https://one.dash.cloudflare.com (or **Zero Trust** in the main dashboard's left menu).

1. **Zero Trust.** Open it and finish its onboarding: pick a team name (your team domain becomes `<team>.cloudflareaccess.com`) and the Free plan, whose payment step you cannot skip but which charges nothing ([setup](https://developers.cloudflare.com/cloudflare-one/setup/)).
2. **One-time PIN.** Zero Trust › Integrations › Identity providers › **Add new identity provider** › **One-time PIN**. New organisations no longer get it automatically ([One-time PIN](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)).
3. **The two service tokens.** Zero Trust › Access controls › Service credentials › Service Tokens › **Create Service Token**: create `la-table-cli` and `la-table-build` ([service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)). Each shows its Client ID and Client Secret once, on creation: keep each pair until step 6 puts it in its home. Choose the longest duration offered. An expired token makes every deploy stop with « jeton Access refusé » (exit 2): before it expires, select **Refresh** on the token (one more year) or **Edit** for a longer duration. A token you recreate instead has a new pair, to enter again in its home (step 6).
4. **Access on the Worker.** Workers & Pages › `la-table` › Settings › Domains & Routes, on the workers.dev row: enable Cloudflare Access. This creates an Access application covering the Worker's workers.dev address. The app has no preview addresses (`preview_urls: false` in `wrangler.jsonc`, which the deploy gate enforces), so there is nothing else to cover.
5. **The application.** Zero Trust › Access controls › Applications, open the new application:
   - add a **public hostname destination** `la-table.<your-subdomain>.workers.dev` (without it, a login started from the app shows « code sent » and sends nothing). If the application created from the Worker offers no way to add one, delete it and create a **self-hosted** application for that hostname yourself (this fallback has not been tried);
   - allow the **One-time PIN** login method on it;
   - policies: open the application's policies first and delete or narrow any policy already attached (whether the Worker toggle adds a default one is unverified), so that the only **Allow** policy is yours. Then, inside the application (or in Access controls › Policies, then attached to it): one with action **Allow**, including the **emails** of the people who will use the app; one with action **Service Auth**, including the **service tokens** `la-table-cli` and `la-table-build`. A service token goes only in a Service Auth policy: in an Allow policy, Access asks it for a login.
6. **The two values.** The AUD tag is on the application's overview, as **Application Audience (AUD) Tag**. The team domain is under Zero Trust › Settings (the name ending in `.cloudflareaccess.com`). Write them into `wrangler.jsonc`: `ACCESS_AUD`, and `ACCESS_TEAM_DOMAIN` as the host alone, with no `https://` and no `/` (like the table's row); and the AUD into `.gitleaks.toml`.

Check it. In a private browser window, the address must show the Access login page, and an email you listed must receive a code that lets you through to the placeholder's 503. Then with the CLI's token (from any OS), setting your subdomain first:

```bash
SUB=your-subdomain
curl -s -o /dev/null -w '%{http_code}\n' "https://la-table.$SUB.workers.dev/api/health" \
  -H "CF-Access-Client-Id: <la-table-cli Client ID>" -H "CF-Access-Client-Secret: <la-table-cli Client Secret>"
```

prints `503` (the placeholder, reached through Access); without the two headers, `302` (the login). Once the real app is deployed (step 7) the same command with the headers prints `200`. On macOS, once the token is in the keychain (step 6), `npm run probe:live -- --placeholder` runs the full check: the login without a session, the token let through, a JWT for your AUD.

### Step 6. Two service tokens, two homes

Each token lives in exactly one place. Never copy one into the other's.

- **`la-table-build` → Workers Builds' build secrets**, as `LA_TABLE_ACCESS_CLIENT_ID` and `LA_TABLE_ACCESS_CLIENT_SECRET`, of type secret, never plain variables (step 7). The deploy uses it to see Access let it through before anything is written, and to see the new version answer behind Access at the end.
- **`la-table-cli` → your machine**, for the planning CLI, the probes and a laptop deploy.
  - On macOS, in the login keychain; each command asks for the value at a prompt, so nothing reaches the shell history:

    ```bash
    security add-generic-password -U -s la-table-access-client-id -a "$USER" -w      # paste the Client ID
    security add-generic-password -U -s la-table-access-client-secret -a "$USER" -w  # paste the Client Secret
    ```

  - Elsewhere, as `LA_TABLE_CLI_ACCESS_CLIENT_ID` and `LA_TABLE_CLI_ACCESS_CLIENT_SECRET` in the environment the CLI runs in (set both: one alone exits 2). On macOS these are read only when the keychain yields neither entry. The build's `LA_TABLE_ACCESS_CLIENT_*` names are never read by the CLI: set alone, they exit 2 naming the CLI's.

### Step 7. Workers Builds for the app

Commit your values, then check before pushing:

```bash
node scripts/self-hosting-values.ts --remaining   # every value replaced
npm run typecheck && npm test
git add -A && git commit -m "chore: self-hosting values"
git push
```

Then Workers & Pages › `la-table` › Settings › Build › connect your repository ([configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)). The first time, Cloudflare sends you to GitHub (or GitLab) to install and authorise the Cloudflare Workers and Pages app on the account or organisation that owns the repository: give it access to that repository. Then set:

- **Git branch** `main`; builds for non-production branches **off** where the form offers it;
- **Build command** empty; **Deploy command** exactly `npm run deploy:ci`;
- **Preview command** (the command non-production branches run; `npx wrangler preview` by default per the documentation, `npx wrangler versions upload` on older entries): `npm run deploy:ci` too. Its gate exits 1 on any branch but `main`, so a preview build fails closed instead of uploading anything;
- **Root directory** empty;
- **Build variables and secrets**: `LA_TABLE_ACCESS_CLIENT_ID` and `LA_TABLE_ACCESS_CLIENT_SECRET`, type **Secret** where the form offers a type, with the `la-table-build` pair;
- Node: Workers Builds reads `.nvmrc` (24); if the build log shows another major version, add a build variable `NODE_VERSION=24` ([build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/));
- **API token**: let Cloudflare create one. It is the credential the deploy reads Cloudflare's API with (your account's workers.dev subdomain, the Worker's routes, custom domains and secrets) and deploys and migrates with. Per the documentation the token it creates holds Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit), Workers Routes (edit) on the account's zones, User Details (read) and Memberships (read); D1 is not in that list. If the log says an API answer was unreadable (exit 2), or the bookmark or the migrations fail on authorisation, open My Profile › API Tokens (or the account's API tokens), edit the token named for this Worker's builds and add the missing permission (D1 (edit) for the migrations), or pick another token in Settings › Build › API token.

Connecting does not build the commit already on `main`. Start the first build with an empty commit, or with the dashboard's retry on the entry if it offers one:

```bash
git commit --allow-empty -m "chore: first build" && git push
```

Every push to `main` now runs `npm run deploy:ci`: the configuration gate, your account's subdomain checked against `DEFAULT_URL`, any route, custom domain or secret on the Worker refused, Access probed and the build's token tried, then typecheck, tests and build of an export of the pushed commit, the D1 bookmark, the migrations, Access asked again, the deploy tagged with the commit, and that tag seen answering behind Access. Red at any step, nothing is deployed after it. Retry a failed build from the dashboard once its cause is fixed. What each refusal means: [docs/deploy.md](docs/deploy.md), and for an agent [.claude/skills/la-table-deploy/SKILL.md](.claude/skills/la-table-deploy/SKILL.md).

When the build is green, open the address on a phone, log in with the code, and add the app to the home screen. Never run `wrangler deploy` on the app by hand, and never `wrangler secret put` on it.

The laptop deploy, `npm run deploy` (macOS only), runs the same gate from a clean tree at `main` as `MAIN_REMOTE` holds it, with your `wrangler login` and the `la-table-cli` token from the keychain.

### Step 8. The demo, optional

The demo is a second Worker, `la-table-demo`: the same app on invented data, its server running in the browser, assets only, with no Access, no database and no variable. Nothing real may ever reach it. It deploys only from its own Workers Builds entry, never from a shell (its gate refuses outside Workers Builds). Create it with Workers & Pages › Create › Import a repository, your repository, Worker name `la-table-demo`.

**Set the commands in the creation form, before pressing Deploy.** The form's **Deploy command** defaults to `npx wrangler deploy`, and the first build starts on Deploy: with the default, Workers Builds deploys under the entry's name whatever the configuration says, so it would read `wrangler.jsonc` and publish the app's code, D1 binding and variables as `la-table-demo`, with no Access in front. Open the form's advanced or build settings and set:

- **Deploy command** exactly `npm run deploy:demo`;
- **Preview command** (default `npx wrangler preview` per the documentation, `npx wrangler versions upload` on older entries) exactly `npm run deploy:demo` too: the default has no `--config`, so it would upload the app as a version of the demo, while the demo's gate refuses every branch but `main`;
- **Git branch** `main`; non-production branch builds off;
- no build secret;
- **Build watch paths** (Settings › Build › Build watch paths, **Include paths**): the paths `node scripts/demo-watch-paths.ts` prints, one per line. Left empty, every push rebuilds the demo, which is harmless but uses build minutes ([watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)).

If the form does not show the commands before its first build, let that first build fail rather than run: cancel it from the entry's deployments if it starts, set the commands in Settings › Build, then retry. Once the entry exists, check that both commands read `npm run deploy:demo`.

Never paste `npm run deploy:demo` into the app's entry: Workers Builds deploys under the entry's Worker name whatever the configuration says, so it would publish the demo over the app.

### Step 9. Backups and the restore drill

- Before each planning, `npm run backup` exports the remote database into `backups/` (gitignored). Exit 2 means no usable backup: do not plan.
- Now and then, `npm run restore-drill` restores the newest backup into a scratch local database and checks every table, index, trigger and row count.
- Between backups, D1 Time Travel can bring the database back to a point in time: up to 7 days back on Workers Free, 30 on Workers Paid ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). Each deploy prints a bookmark taken before its migrations. `npx wrangler d1 time-travel restore la-table --bookmark=<bookmark>` restores one (read `npx wrangler d1 time-travel restore --help` first).
- From a backup file (untested remotely; the drill rehearses it locally only): the deploy gate accepts only a database named `la-table`, so take a last backup, delete the old database, `npx wrangler d1 create la-table`, then `npx wrangler d1 execute la-table --remote --file=<backup>`, put the new id in `wrangler.jsonc`, push. Whether the export loads as is into a remote database (it carries the migrations table) has not been checked.

Details and exit codes: [docs/planning-cli.md](docs/planning-cli.md).

### Step 10. Updates from the mirror

```bash
git fetch upstream
git merge upstream/main
```

Conflicts come where your values and the mirror's changes meet, in the files of step 2 and possibly in the same hunks as other upstream changes (in `wrangler.jsonc`, for example). Resolve each by hand: keep your value, and take every other change upstream made. Then:

```bash
node scripts/self-hosting-values.ts --remaining   # must still say every value replaced
npm ci && npm run typecheck && npm test
git push
```

The push deploys through Workers Builds; new migrations are applied by the deploy, after its bookmark. Take a backup before pushing an update that adds a migration.

### Step 11. Planning with Claude Code

Claude Code is optional: it is Anthropic's coding assistant, needs a paid Claude plan or an Anthropic Console account, and installs from https://code.claude.com/docs/en/setup. The planning happens in a Claude Code session started at the repository's root. The project skill `.claude/skills/la-table-planning/SKILL.md` holds the session's protocol and loads when you ask for a planning: it takes the backup, starts with `npm run plan -- status` (receipts to settle, leftovers to describe, meals left short), proposes meals from the season, the budget, recent meals and what is left, and writes the chosen week through `npm run plan -- commit`. Without Claude Code, every command works by hand: [docs/planning-cli.md](docs/planning-cli.md). The phone app is described in [docs/phone-app.md](docs/phone-app.md).

### When something fails

- **A login shows « code sent » and no mail comes:** the Access application lacks its public hostname destination, or the One-time PIN method.
- **The deploy stops with « jeton Access refusé » (exit 2):** the `la-table-build` token is not in the Service Auth policy, its ID and secret were pasted swapped, or it has expired (refresh it, step 5.3).
- **The deploy says `DEFAULT_URL` is on another account's subdomain (exit 1):** `src/cli/client.ts` still holds the mirror's address, or your subdomain is mistyped.
- **A route, a custom domain or a secret on the Worker (exit 1):** remove it in the dashboard (or `npx wrangler secret delete <name>`); the app has its workers.dev address only and no secret.
- **The build log shows Node other than 24, or `npm ci` refuses the engine:** add the build variable `NODE_VERSION=24` (step 7).
- **The CLI exits 2 before sending anything:** a token is missing, one of the pair is set alone, or `DEFAULT_URL` still carries the mirror's address; the message names which.

<a id="français"></a>

## Français

Ce guide installe votre propre exemplaire de La Table sur votre propre compte Cloudflare : l'application, sa base, sa connexion, ses déploiements et, si vous la voulez, sa démo. Il suppose l'aisance avec un terminal, git et un tableau de bord en ligne. Retour au [README](README.md).

### Ce qui protège l'application

Cloudflare Access est la protection, rien d'autre. L'application répond à l'adresse propre de son Worker, `https://la-table.<votre-sous-domaine>.workers.dev`, et Access se tient devant chacun de ses chemins : un visiteur sans session reçoit la page de connexion d'Access, qui n'envoie un code à usage unique qu'aux adresses électroniques que vous avez listées. L'adresse n'est pas un secret, pas plus que l'identifiant du compte, celui de la base, le domaine d'équipe Access ou l'étiquette AUD : ils figurent en clair dans la configuration de votre dépôt, et ce dépôt peut être public. Les secrets sont votre identifiant Cloudflare et les secrets des deux jetons de service, et aucun n'est jamais écrit dans le dépôt. Le Worker lui-même ne détient aucun secret, et le déploiement refuse de tourner quand on lui en a ajouté un.

### Prérequis

- Un compte Cloudflare, avec la double authentification activée (la page de mise en route de Zero Trust le recommande). Tout tient dans les offres gratuites : Workers Free, D1, Workers Builds, et Cloudflare Zero Trust Free pour Access. La mise en route de Zero Trust demande un moyen de paiement même pour l'offre Free, sans rien prélever. Workers Builds Free accorde 3 000 minutes de construction par mois, une construction à la fois, et 20 minutes par construction (page des limites de Cloudflare, 15 novembre 2026) ; un déploiement de l'application prend quelques minutes.
- Un compte GitHub ou GitLab, pour le dépôt d'où Workers Builds déploie.
- Node 24 (`.nvmrc` ; `package.json` refuse une autre version majeure) et git. Avec nvm ou fnm, `nvm install` ou `fnm use --install-if-missing` dans le dépôt lit `.nvmrc` ; sinon, prenez l'installateur v24 sur https://nodejs.org/en/download.
- Quelle machine :
  - **Workers Builds est la voie de déploiement, et elle est la même depuis tout système :** vous poussez sur `main`, Cloudflare construit et déploie.
  - **Le CLI de planification** (`npm run plan -- …`) tourne sur tout système : sur macOS il lit son jeton dans le trousseau de session, ailleurs dans deux variables d'environnement (plus bas).
  - **Le déploiement depuis l'ordinateur (`npm run deploy`) et les sondes en ligne (`npm run probe:live`, `npm run probe:burst`) ne lisent que le trousseau : macOS seulement.** Hors macOS, déployez par Workers Builds et vérifiez l'adresse avec `curl` comme indiqué plus bas.
  - `npm run backup` et `npm run restore-drill` lancent wrangler avec votre `wrangler login` ; ils n'ont tourné que sur macOS.

Les libellés du tableau de bord cités ici ont été vérifiés le 15 novembre 2026 sur la documentation de Cloudflare, pas sur un tableau de bord réel. Cloudflare les renomme de temps à autre ; quand un libellé diffère, les pages de documentation liées à chaque étape font foi.

### Étape 1. Le code dans votre propre dépôt

```bash
git clone https://github.com/w2ur/la-table-app.git la-table
cd la-table
git remote rename origin upstream        # le miroir public, pour les mises à jour
# créez un dépôt vide sur GitHub ou GitLab, puis :
git remote add origin <l'URL de votre dépôt>
git push -u origin main
npm ci
npx wrangler login                       # ouvre un navigateur sur cette machine ; wrangler garde une connexion OAuth
npx wrangler whoami                      # affiche l'identifiant de votre compte
```

`wrangler login` demande un navigateur sur la même machine. Sur une machine sans écran ou distante, créez un jeton d'API dans le tableau de bord (My Profile › API Tokens) et exportez-le sous `CLOUDFLARE_API_TOKEN` : wrangler le lit, et les étapes wrangler du déploiement et de la sauvegarde le transmettent (la sauvegarde avec un jeton n'a pas été essayée).

Le sous-domaine workers.dev de votre compte : **Workers & Pages** dans le tableau de bord affiche **Your subdomain** (avec Change à côté). S'il n'en existe pas encore, choisissez-le là maintenant : `DEFAULT_URL` en a besoin à l'étape 2, et le `wrangler deploy` de l'étape 4 s'arrêterait sinon pour en demander un. C'est le `<votre-sous-domaine>` de toutes les adresses ci-dessous.

### Étape 2. Les valeurs à remplacer

Chaque valeur ci-dessous appartient au propriétaire du miroir et doit devenir la vôtre. Gardez tout le reste tel quel : le Worker doit rester nommé `la-table` et la base `la-table` (le contrôle de déploiement refuse un autre nom), et le Worker de démo `la-table-demo`.

<!-- replace-values -->
| Quoi | Valeur dans le miroir | Fichiers qui la portent |
|---|---|---|
| Identifiant du compte Cloudflare (`npx wrangler whoami`) | `44513f9fd94c38330fc5ca98603adf15` | `wrangler.jsonc`, `wrangler.demo.jsonc`, `probes/placeholder/wrangler.jsonc`, `probes/d1-limit/wrangler.jsonc` |
| Identifiant de la base D1 (étape 3) | `ca55d47f-86a2-40a0-bc1d-a07715071804` | `wrangler.jsonc` |
| Domaine d'équipe Access (étape 5) | `william-445.cloudflareaccess.com` | `wrangler.jsonc` |
| Étiquette AUD de l'application Access (étape 5) | `6e02bad1e8d730288705b85a6ff3c01332f1b51685e9ead3064971c7634cb7c3` | `wrangler.jsonc`, `.gitleaks.toml` |
| L'adresse de l'application, `DEFAULT_URL` : `https://la-table.<votre-sous-domaine>.workers.dev`, rien après l'hôte | `https://la-table.william-445.workers.dev` | `src/cli/client.ts` |
| `MAIN_REMOTE` : l'URL HTTPS de clonage de votre dépôt, où un déploiement depuis l'ordinateur lit `main` | `https://github.com/w2ur/la-table.git` | `scripts/deploy-ci.ts` |
<!-- /replace-values -->

Les valeurs n'existent pas encore toutes. Remplissez maintenant l'identifiant du compte, `DEFAULT_URL` et `MAIN_REMOTE` ; l'identifiant D1 après l'étape 3 ; le domaine d'équipe et l'AUD après l'étape 5. Pour en remplir une, cherchez sa « Valeur dans le miroir » et remplacez-la par la vôtre dans chaque fichier listé (la fonction chercher-remplacer d'un éditeur, ou `sed`), sans toucher au reste de la ligne.

Sur chaque fichier :

- `wrangler.jsonc` est l'application. `wrangler.demo.jsonc` est la démo, dont le compte doit être celui de l'application (son contrôle de déploiement le vérifie). `probes/placeholder/wrangler.jsonc` est le Worker provisoire de l'étape 4. `probes/d1-limit/wrangler.jsonc` ne sert qu'à une mesure ponctuelle que vous ne lancerez sans doute jamais, mais la suite de tests le lit : changez-le aussi.
- `.gitleaks.toml` ne compte que si vous passez gitleaks sur votre dépôt : il exempte l'étiquette AUD par sa valeur exacte, dans une expression régulière, si bien qu'une nouvelle AUD doit y figurer, sans aucun autre caractère changé.
- `DEFAULT_URL` est la seule adresse à laquelle le CLI, les sondes et le déploiement envoient un jeton de service, et le déploiement vérifie qu'elle est sur le sous-domaine workers.dev de votre compte.

`node scripts/self-hosting-values.ts --remaining` liste chaque valeur de ce tableau encore présente dans son fichier (sortie 1 tant qu'il en reste une, 0 quand il n'en reste aucune). C'est lui la vérification, pas ce tableau : lancez-le après chaque remplacement pour voir ce qui reste, attendez-vous à ce qu'il ne passe qu'à l'étape 7, et relancez-le après chaque mise à jour depuis le miroir.

### Étape 3. La base

```bash
npx wrangler d1 create la-table
```

Reportez le `database_id` affiché dans `wrangler.jsonc`, dans l'entrée `d1_databases` existante. Si wrangler propose d'ajouter lui-même la base à la configuration, refusez, ou vérifiez ensuite que `d1_databases` ne tient qu'une entrée : le déploiement en refuse une seconde. Les migrations ne s'appliquent pas à la main : chaque déploiement affiche un marque-page D1 Time Travel (le point de restauration), applique à distance les migrations en attente de `migrations/`, et vérifie qu'il n'en reste aucune.

### Étape 4. Un Worker provisoire sous le nom de l'application

Access se pose sur un Worker qui existe, et le vrai déploiement refuse de tourner tant qu'il ne voit pas Access devant l'adresse. La première chose déployée sous le nom `la-table` est donc un remplaçant sans données ni liaison, qui répond 503 à tout :

```bash
npx wrangler deploy -c probes/placeholder/wrangler.jsonc
```

C'est la seule fois où `la-table` est déployé hors de `npm run deploy:ci`. Tant que l'étape 5 n'est pas faite, son adresse répond à tout le monde, sans danger : elle ne tient rien.

### Étape 5. Cloudflare Access

Zero Trust se trouve à https://one.dash.cloudflare.com (ou **Zero Trust** dans le menu de gauche du tableau de bord principal).

1. **Zero Trust.** Ouvrez-le et terminez sa mise en route : un nom d'équipe (votre domaine d'équipe devient `<équipe>.cloudflareaccess.com`) et l'offre Free, dont l'étape de paiement est obligatoire mais ne prélève rien ([mise en route](https://developers.cloudflare.com/cloudflare-one/setup/)).
2. **Code à usage unique.** Zero Trust › Integrations › Identity providers › **Add new identity provider** › **One-time PIN**. Les nouvelles organisations ne l'ont plus d'office ([One-time PIN](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)).
3. **Les deux jetons de service.** Zero Trust › Access controls › Service credentials › Service Tokens › **Create Service Token** : créez `la-table-cli` et `la-table-build` ([jetons de service](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)). Chacun montre son Client ID et son Client Secret une seule fois, à la création : gardez chaque paire jusqu'à ce que l'étape 6 la range. Choisissez la plus longue durée proposée. Un jeton expiré arrête chaque déploiement sur « jeton Access refusé » (sortie 2) : avant l'échéance, choisissez **Refresh** sur le jeton (une année de plus) ou **Edit** pour une durée plus longue. Un jeton recréé à la place a une nouvelle paire, à reporter dans sa demeure (étape 6).
4. **Access sur le Worker.** Workers & Pages › `la-table` › Settings › Domains & Routes, sur la ligne workers.dev : activez Cloudflare Access. Cela crée une application Access qui couvre l'adresse workers.dev du Worker. L'application n'a pas d'adresses de prévisualisation (`preview_urls: false` dans `wrangler.jsonc`, que le contrôle de déploiement impose) : il n'y a rien d'autre à couvrir.
5. **L'application.** Zero Trust › Access controls › Applications, ouvrez la nouvelle application :
   - ajoutez une **destination de nom d'hôte public** `la-table.<votre-sous-domaine>.workers.dev` (sans elle, une connexion lancée depuis l'application affiche « code envoyé » et n'envoie rien). Si l'application créée depuis le Worker ne permet pas d'en ajouter une, supprimez-la et créez vous-même une application **self-hosted** pour ce nom d'hôte (ce repli n'a pas été essayé) ;
   - autorisez-y la méthode de connexion **One-time PIN** ;
   - règles : ouvrez d'abord les règles de l'application et supprimez ou restreignez toute règle déjà attachée (on ne sait pas si l'interrupteur du Worker en ajoute une par défaut), pour que la seule règle **Allow** soit la vôtre. Puis, dans l'application (ou dans Access controls › Policies, puis attachées à elle) : une d'action **Allow**, qui inclut les **adresses électroniques** des personnes qui se serviront de l'application ; une d'action **Service Auth**, qui inclut les **jetons de service** `la-table-cli` et `la-table-build`. Un jeton de service ne va que dans une règle Service Auth : dans une règle Allow, Access lui demande une connexion.
6. **Les deux valeurs.** L'étiquette AUD est sur la vue d'ensemble de l'application, sous **Application Audience (AUD) Tag**. Le domaine d'équipe est sous Zero Trust › Settings (le nom qui finit par `.cloudflareaccess.com`). Reportez-les dans `wrangler.jsonc` : `ACCESS_AUD`, et `ACCESS_TEAM_DOMAIN` sous la forme de l'hôte seul, sans `https://` ni `/` (comme la ligne du tableau) ; et l'AUD dans `.gitleaks.toml`.

Vérifiez. Dans une fenêtre de navigation privée, l'adresse doit afficher la page de connexion d'Access, et une adresse listée doit recevoir un code qui mène au 503 du Worker provisoire. Puis, avec le jeton du CLI (depuis tout système), en posant d'abord votre sous-domaine :

```bash
SUB=votre-sous-domaine
curl -s -o /dev/null -w '%{http_code}\n' "https://la-table.$SUB.workers.dev/api/health" \
  -H "CF-Access-Client-Id: <Client ID de la-table-cli>" -H "CF-Access-Client-Secret: <Client Secret de la-table-cli>"
```

affiche `503` (le Worker provisoire, atteint à travers Access) ; sans les deux en-têtes, `302` (la connexion). Une fois la vraie application déployée (étape 7), la même commande avec les en-têtes affiche `200`. Sur macOS, une fois le jeton dans le trousseau (étape 6), `npm run probe:live -- --placeholder` fait la vérification complète : la connexion sans session, le jeton admis, un JWT pour votre AUD.

### Étape 6. Deux jetons de service, deux demeures

Chaque jeton vit en un seul endroit. Ne copiez jamais l'un à la place de l'autre.

- **`la-table-build` → les secrets de construction de Workers Builds**, sous `LA_TABLE_ACCESS_CLIENT_ID` et `LA_TABLE_ACCESS_CLIENT_SECRET`, de type secret, jamais en variables simples (étape 7). Le déploiement s'en sert pour voir Access le laisser passer avant d'écrire quoi que ce soit, et pour voir la nouvelle version répondre derrière Access à la fin.
- **`la-table-cli` → votre machine**, pour le CLI de planification, les sondes et un déploiement depuis l'ordinateur.
  - Sur macOS, dans le trousseau de session ; chaque commande demande la valeur à l'invite, si bien que rien n'entre dans l'historique du terminal :

    ```bash
    security add-generic-password -U -s la-table-access-client-id -a "$USER" -w      # collez le Client ID
    security add-generic-password -U -s la-table-access-client-secret -a "$USER" -w  # collez le Client Secret
    ```

  - Ailleurs, sous `LA_TABLE_CLI_ACCESS_CLIENT_ID` et `LA_TABLE_CLI_ACCESS_CLIENT_SECRET` dans l'environnement où tourne le CLI (posez les deux : une seule donne la sortie 2). Sur macOS, elles ne sont lues que si le trousseau ne rend aucune des deux entrées. Le CLI ne lit jamais les noms du déploiement, `LA_TABLE_ACCESS_CLIENT_*` : posés seuls, ils donnent la sortie 2 en nommant ceux du CLI.

### Étape 7. Workers Builds pour l'application

Validez vos valeurs dans un commit, puis vérifiez avant de pousser :

```bash
node scripts/self-hosting-values.ts --remaining   # toutes les valeurs remplacées
npm run typecheck && npm test
git add -A && git commit -m "chore: self-hosting values"
git push
```

Puis Workers & Pages › `la-table` › Settings › Build › reliez votre dépôt ([configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)). La première fois, Cloudflare vous envoie sur GitHub (ou GitLab) installer et autoriser l'application Cloudflare Workers and Pages sur le compte ou l'organisation qui possède le dépôt : donnez-lui accès à ce dépôt. Puis réglez :

- **Git branch** `main` ; constructions des autres branches **désactivées** là où le formulaire le propose ;
- **Build command** vide ; **Deploy command** exactement `npm run deploy:ci` ;
- **Preview command** (la commande des autres branches ; `npx wrangler preview` par défaut selon la documentation, `npx wrangler versions upload` sur les entrées plus anciennes) : `npm run deploy:ci` aussi. Son contrôle sort en 1 sur toute autre branche que `main`, si bien qu'une construction de prévisualisation échoue sans rien téléverser ;
- **Root directory** vide ;
- **Build variables and secrets** : `LA_TABLE_ACCESS_CLIENT_ID` et `LA_TABLE_ACCESS_CLIENT_SECRET`, de type **Secret** là où le formulaire propose un type, avec la paire de `la-table-build` ;
- Node : Workers Builds lit `.nvmrc` (24) ; si le journal de construction montre une autre version majeure, ajoutez une variable de construction `NODE_VERSION=24` ([image de construction](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)) ;
- **API token** : laissez Cloudflare en créer un. C'est l'identifiant avec lequel le déploiement interroge l'API de Cloudflare (le sous-domaine workers.dev de votre compte, les routes, domaines personnalisés et secrets du Worker), déploie et migre. Selon la documentation, le jeton qu'il crée porte Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit), Workers Routes (edit) sur les zones du compte, User Details (read) et Memberships (read) ; D1 n'est pas dans cette liste. Si le journal dit qu'une réponse de l'API était illisible (sortie 2), ou si le marque-page ou les migrations échouent faute d'autorisation, ouvrez My Profile › API Tokens (ou les jetons d'API du compte), modifiez le jeton nommé d'après les constructions de ce Worker et ajoutez la permission qui manque (D1 (edit) pour les migrations), ou choisissez un autre jeton dans Settings › Build › API token.

Relier le dépôt ne construit pas le commit déjà sur `main`. Lancez la première construction avec un commit vide, ou avec la relance du tableau de bord si l'entrée en propose une :

```bash
git commit --allow-empty -m "chore: first build" && git push
```

Chaque poussée sur `main` lance désormais `npm run deploy:ci` : le contrôle de configuration, le sous-domaine de votre compte comparé à `DEFAULT_URL`, toute route, tout domaine personnalisé ou secret sur le Worker refusé, Access sondé et le jeton du déploiement essayé, puis vérification des types, tests et construction d'un export du commit poussé, le marque-page D1, les migrations, Access de nouveau interrogé, le déploiement marqué du commit, et cette marque vue répondre derrière Access. Une étape en échec, rien n'est déployé après elle. Relancez une construction échouée depuis le tableau de bord une fois sa cause réglée. Ce que veut dire chaque refus : [docs/deploy.md](docs/deploy.md), et pour un agent [.claude/skills/la-table-deploy/SKILL.md](.claude/skills/la-table-deploy/SKILL.md).

Une fois la construction au vert, ouvrez l'adresse sur un téléphone, connectez-vous avec le code, et ajoutez l'application à l'écran d'accueil. Ne lancez jamais `wrangler deploy` à la main sur l'application, ni `wrangler secret put`.

Le déploiement depuis l'ordinateur, `npm run deploy` (macOS seulement), passe le même contrôle depuis un arbre propre à `main` tel que `MAIN_REMOTE` le tient, avec votre `wrangler login` et le jeton `la-table-cli` du trousseau.

### Étape 8. La démo, facultative

La démo est un second Worker, `la-table-demo` : la même application sur des données inventées, son serveur tournant dans le navigateur, des fichiers statiques seulement, sans Access, sans base et sans variable. Rien de réel ne doit jamais y parvenir. Elle ne se déploie que depuis sa propre entrée Workers Builds, jamais depuis un terminal (son contrôle refuse hors de Workers Builds). Créez-la par Workers & Pages › Create › Import a repository, votre dépôt, nom du Worker `la-table-demo`.

**Réglez les commandes dans le formulaire de création, avant d'appuyer sur Deploy.** La **Deploy command** du formulaire vaut par défaut `npx wrangler deploy`, et la première construction part sur Deploy : avec la valeur par défaut, Workers Builds déploie sous le nom de l'entrée quoi que dise la configuration, et lirait donc `wrangler.jsonc` pour publier le code, la liaison D1 et les variables de l'application sous `la-table-demo`, sans Access devant. Ouvrez les réglages avancés ou de construction du formulaire et réglez :

- **Deploy command** exactement `npm run deploy:demo` ;
- **Preview command** (par défaut `npx wrangler preview` selon la documentation, `npx wrangler versions upload` sur les entrées plus anciennes) exactement `npm run deploy:demo` aussi : la valeur par défaut n'a pas de `--config`, et téléverserait l'application comme une version de la démo, alors que le contrôle de la démo refuse toute autre branche que `main` ;
- **Git branch** `main` ; constructions des autres branches désactivées ;
- aucun secret de construction ;
- **Build watch paths** (Settings › Build › Build watch paths, **Include paths**) : les chemins qu'affiche `node scripts/demo-watch-paths.ts`, un par ligne. Laissés vides, chaque poussée reconstruit la démo, sans danger mais aux dépens des minutes de construction ([chemins surveillés](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)).

Si le formulaire n'affiche pas les commandes avant sa première construction, faites échouer cette construction plutôt que de la laisser tourner : annulez-la dans les déploiements de l'entrée si elle démarre, réglez les commandes dans Settings › Build, puis relancez. Une fois l'entrée créée, vérifiez que les deux commandes disent `npm run deploy:demo`.

Ne collez jamais `npm run deploy:demo` dans l'entrée de l'application : Workers Builds déploie sous le nom du Worker de l'entrée quoi que dise la configuration, et publierait la démo par-dessus l'application.

### Étape 9. Sauvegardes et exercice de restauration

- Avant chaque planification, `npm run backup` exporte la base distante dans `backups/` (ignoré par git). La sortie 2 signifie aucune sauvegarde utilisable : ne planifiez pas.
- De temps à autre, `npm run restore-drill` restaure la sauvegarde la plus récente dans une base locale jetable et vérifie chaque table, index, déclencheur et nombre de lignes.
- Entre deux sauvegardes, D1 Time Travel peut ramener la base à un instant passé : jusqu'à 7 jours en arrière sur Workers Free, 30 sur Workers Paid ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). Chaque déploiement affiche un marque-page pris avant ses migrations. `npx wrangler d1 time-travel restore la-table --bookmark=<marque-page>` en restaure un (lisez d'abord `npx wrangler d1 time-travel restore --help`).
- Depuis un fichier de sauvegarde (non essayé à distance ; l'exercice ne le répète qu'en local) : le contrôle de déploiement n'accepte qu'une base nommée `la-table`, donc faites une dernière sauvegarde, supprimez l'ancienne base, `npx wrangler d1 create la-table`, puis `npx wrangler d1 execute la-table --remote --file=<sauvegarde>`, mettez le nouvel identifiant dans `wrangler.jsonc`, poussez. On n'a pas vérifié que l'export se charge tel quel dans une base distante (il porte la table des migrations).

Détails et codes de sortie : [docs/planning-cli.md](docs/planning-cli.md).

### Étape 10. Mises à jour depuis le miroir

```bash
git fetch upstream
git merge upstream/main
```

Les conflits naissent là où vos valeurs croisent les changements du miroir, dans les fichiers de l'étape 2 et parfois dans les mêmes blocs que d'autres changements (dans `wrangler.jsonc`, par exemple). Résolvez-les un à un, à la main : gardez votre valeur, et prenez tous les autres changements du miroir. Puis :

```bash
node scripts/self-hosting-values.ts --remaining   # doit toujours dire toutes les valeurs remplacées
npm ci && npm run typecheck && npm test
git push
```

La poussée déploie par Workers Builds ; le déploiement applique les nouvelles migrations, après son marque-page. Faites une sauvegarde avant de pousser une mise à jour qui ajoute une migration.

### Étape 11. Planifier avec Claude Code

Claude Code est facultatif : c'est l'assistant de programmation d'Anthropic, il demande une offre Claude payante ou un compte Anthropic Console, et s'installe depuis https://code.claude.com/docs/en/setup. La planification se fait dans une session Claude Code ouverte à la racine du dépôt. La compétence du projet `.claude/skills/la-table-planning/SKILL.md` tient le déroulé de la séance et se charge quand vous demandez une planification : elle fait la sauvegarde, commence par `npm run plan -- status` (tickets à régler, restes à décrire, repas incomplets), propose des repas selon la saison, le budget, les repas récents et ce qui reste, et écrit la semaine choisie par `npm run plan -- commit`. Sans Claude Code, chaque commande se lance à la main : [docs/planning-cli.md](docs/planning-cli.md). L'application du téléphone est décrite dans [docs/phone-app.md](docs/phone-app.md).

### Quand quelque chose échoue

- **Une connexion affiche « code envoyé » et aucun courriel n'arrive :** il manque à l'application Access sa destination de nom d'hôte public, ou la méthode One-time PIN.
- **Le déploiement s'arrête sur « jeton Access refusé » (sortie 2) :** le jeton `la-table-build` n'est pas dans la règle Service Auth, son ID et son secret ont été collés à l'envers, ou il a expiré (prolongez-le, étape 5.3).
- **Le déploiement dit que `DEFAULT_URL` est sur le sous-domaine d'un autre compte (sortie 1) :** `src/cli/client.ts` tient encore l'adresse du miroir, ou votre sous-domaine est mal recopié.
- **Une route, un domaine personnalisé ou un secret sur le Worker (sortie 1) :** retirez-le dans le tableau de bord (ou `npx wrangler secret delete <nom>`) ; l'application n'a que son adresse workers.dev et aucun secret.
- **Le journal de construction montre un Node autre que 24, ou `npm ci` refuse la version :** ajoutez la variable de construction `NODE_VERSION=24` (étape 7).
- **Le CLI sort en 2 avant d'envoyer quoi que ce soit :** un jeton manque, un seul des deux est posé, ou `DEFAULT_URL` porte encore l'adresse du miroir ; le message dit lequel.
