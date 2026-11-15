# La Table, your own copy: the beginner's guide

- [English](#english)
- [Français](#français)

---

<a id="english"></a>

## English

This guide puts your own copy of La Table online, on your own Cloudflare account, for two people. It assumes you have never used a terminal or GitHub: every step says where to click, what to copy, and how to check it worked. If you are at ease with a terminal and git, the shorter [SELF-HOSTING.md](SELF-HOSTING.md) covers the same ground. Back to the [README](README.md).

At the end you will have:

- your own web address, `https://la-table.<your-subdomain>.workers.dev`, which asks for an email address and lets in only the people you list, with a code sent by email;
- your own database, which only your copy uses;
- an app you can add to your phone's home screen;
- on a Mac, a planning session with Claude Code that fills the week's meals and shopping list.

The app is in French. Its three lists are **Menu** (the meals), **Courses** (the shopping, by aisle) and **Reste** (what is left at home).

**Read this before you start.** The meals and the shopping list come only from the planning session (Part 2), which needs a Mac and a paid Claude plan. The phones read and tick the lists; they can add a shopping item or something found at home, but never a meal. Without Part 2, the app stays empty.

### What this costs

| Service | What it does here | Price |
|---|---|---|
| GitHub | keeps your copy of the code | free account |
| Cloudflare | runs the app, its database and its login | free plans: Workers Free, D1, Workers Builds, Zero Trust Free |
| Claude (Part 2) | runs the planning session in Claude Code | a paid plan: Claude Code needs a Pro plan or above, or an Anthropic Console account; the free plan does not include it |

Cloudflare's Zero Trust sign-up asks for payment details even for the free plan; it charges nothing (Cloudflare's setup page, checked 2026-11-15). Providers change their prices and limits: check https://claude.com/pricing and Cloudflare's plans page before you start.

### What protects the app

Cloudflare Access does, nothing else. Anyone can know the address: a visitor without a session gets Cloudflare's login page, which sends a code only to the email addresses you list. Your copy of the code is public on GitHub, and that is fine: the values you will put into it (your account id, your database id, your Access team domain and AUD tag, your address) are not secrets. The secrets are your Cloudflare password and the two **service tokens** of step 7. **Never put a service token on GitHub.**

### Before you start

**Words you will meet:**

- **Repository** (or "repo"): a folder of code stored on GitHub.
- **Fork**: your own copy of someone else's repository, on your GitHub account.
- **Commit**: a saved change to a repository. On GitHub you make one with the **Commit changes** button.
- **Worker**: a small program Cloudflare runs for you; La Table is one, named `la-table`.
- **Deploy**: put the code online so it runs as a website.
- **Access**: Cloudflare's login gate in front of the Worker.
- **Service token**: a pair of values (a **Client ID** and a **Client Secret**) that lets a program, not a person, through Access.
- **Terminal**: a window where you type commands instead of clicking. You need it in Part 2 only.

**Open a private notes file** on your computer (a text document only you can see) and paste this into it. You will fill it as you go:

```
Account ID =
workers.dev subdomain =
Database ID =
Team domain =
AUD tag =
la-table-build Client ID =
la-table-build Client Secret =
la-table-cli Client ID =
la-table-cli Client Secret =
```

The two Client Secrets are passwords. **Never post this note anywhere and never put it on GitHub.** Once both tokens are in their final places (steps 10 and 15), delete the four Client ID and Client Secret lines from the note: if you lose one later, you create a new token.

**Use one browser for Part 1**, on a computer rather than a phone. Cloudflare labels below were checked against Cloudflare's documentation on 2026-11-15, not against a live dashboard; Cloudflare and GitHub rename them now and then. When a label differs, look for the nearest match: the documentation page linked in the step is authoritative.

## Part 1: the app online (any computer, browser only)

### Step 1. Create a GitHub account and make your copy

1. Go to https://github.com/signup and create an account. Confirm your email address when GitHub asks.
2. Go to https://github.com/w2ur/la-table-app and click **Fork** (top right).
3. Keep the owner (your account) and the name `la-table-app`, keep **Copy the main branch only** ticked, and click **Create fork**. The copy can take a minute to appear. If your account already has a repository named `la-table-app`, GitHub refuses the name: rename the old one first (its **Settings** › **Repository name**), so that every `la-table-app` in this guide stays right.

**Check:** the page now shows `<your-name>/la-table-app` at the top left, with "forked from w2ur/la-table-app" under it. Write down your copy's address, `https://github.com/<your-name>/la-table-app`.

### Step 2. Create a Cloudflare account, your subdomain and your account ID

1. Go to https://dash.cloudflare.com/sign-up and create an account. Confirm your email address. Cloudflare recommends turning on two-factor authentication now, in your profile's authentication settings: this account will hold your app and its login.
2. In the left menu, open **Workers & Pages** (it may sit under **Compute (Workers)**). The first time, Cloudflare asks you to choose a **workers.dev subdomain**: a short name of your own, lowercase letters, digits and dashes. Choose it and confirm.
3. On the **Workers & Pages** page, the right-hand column shows your **Account ID** and your subdomain (`<your-subdomain>.workers.dev`). If you do not see it there, the account's home page has a menu (**⋯** next to the account name) with **Copy account ID**.
4. Paste both into your notes: the Account ID, and the subdomain alone (without `.workers.dev`).

**Check:** the Account ID is 32 characters, only digits and the letters `a` to `f`. From now on, every `<your-subdomain>` in this guide means the name you chose.

### Step 3. Create the database

1. In the left menu, open **Storage & Databases** › **D1 SQL Database**, then **Create database** (or **Create**).
2. Name it exactly `la-table`. Leave the location as it is. Click **Create**.
3. The database's page shows its **Database ID**, 36 characters in five groups separated by dashes. Copy it into your notes.

Do not create any table: the first deploy does that (step 10).

**Check:** the list under **D1 SQL Database** shows one database named `la-table`.

### Step 4. Create a stand-in Worker named `la-table`

Access is set on a Worker that already exists, and the real deploy refuses to run until it sees Access in front of the address. So you first create a stand-in Worker under the app's name; the first deploy replaces it.

1. **Workers & Pages** › **Create** (or **Create application**) › on the **Workers** tab, **Start with Hello World!** (or the **Hello World** template).
2. The name field comes pre-filled with a random name: replace it with exactly `la-table`. Click **Deploy**.
3. Do not add anything to it: no domain, no route, no variable, no secret. The deploy refuses a Worker that has one.

**Check:** open `https://la-table.<your-subdomain>.workers.dev` in a new tab. It shows "Hello World!". A brand-new subdomain can take a few minutes to answer; if the page does not load, wait and try again. Until step 8, anyone can see this page, which is harmless: it holds nothing.

### Step 5. Turn on Zero Trust and note your team domain

1. In the left menu, open **Zero Trust**. The first time, Cloudflare asks for a **team name**: choose one (lowercase letters, digits, dashes). Your **team domain** becomes `<team-name>.cloudflareaccess.com`.
2. Choose the **Free** plan and finish the sign-up. It asks for payment details even on Free, and charges nothing (see "What this costs"; [Zero Trust setup](https://developers.cloudflare.com/cloudflare-one/setup/)).
3. Paste the team domain, `<team-name>.cloudflareaccess.com`, into your notes.

**Check:** you are now in the Zero Trust dashboard, with its own left menu (**Access**, **Settings** and others). If you forgot the team domain, it is under **Settings** (then **General** or **Custom Pages**): look for the name ending in `.cloudflareaccess.com`.

### Step 6. Turn on the one-time code by email

New Zero Trust accounts no longer get this method automatically ([One-time PIN](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)).

1. In Zero Trust: **Integrations** › **Identity providers** › **Add new identity provider**.
2. Choose **One-time PIN** and save.

**Check:** **Your identity providers** lists **One-time PIN**.

### Step 7. Create the two service tokens

Two programs need to get through Access without a person: the deploy (`la-table-build`) and the planning tool on your Mac (`la-table-cli`). Each gets its own token.

1. In Zero Trust: **Access controls** › **Service credentials** › **Service Tokens** › **Create Service Token** ([service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)).
2. Name it `la-table-build`. Choose a duration: the longest offered; put a reminder in your calendar a week before it ends (an expired token stops the deploy with « jeton Access refusé »). To extend it then, open the token and click **Refresh** (one more year), or **Edit** to choose a longer duration. Click **Generate token**.
3. Cloudflare shows the **Client ID** and the **Client Secret** once, and never again. Copy each into your notes, on the `la-table-build` lines. If they are shown as `CF-Access-Client-Id: xxxx` and `CF-Access-Client-Secret: xxxx`, copy only the part after the colon and the space.
4. Click **Save**.
5. Do it all again with the name `la-table-cli`, into the `la-table-cli` lines.

**Check:** the Client IDs end with `.access`; a Client Secret is a long string, usually starting with `cfast_` (older ones are 64 digits and letters `a` to `f`). **Service Tokens** lists `la-table-build` and `la-table-cli`. If you closed the page before copying a secret, delete that token and create it again.

### Step 8. Put Access in front of the Worker

1. Back in the main Cloudflare dashboard: **Workers & Pages** › `la-table` › **Settings** › **Domains & Routes**.
2. On the `workers.dev` row, turn on **Cloudflare Access** (a switch, or the **⋯** menu › **Enable Cloudflare Access**), and confirm. This creates an Access **application** for the Worker. If a row for preview addresses is shown too, leave it: the app has none.
3. In Zero Trust: **Access controls** › **Applications**. Open the new application (its name contains `la-table`) and choose **Edit** (or **Configure**). On its pages:
   - **Destinations** (or **Public hostname**): add a public hostname `la-table.<your-subdomain>.workers.dev` (subdomain `la-table`, domain `<your-subdomain>.workers.dev`, no path). Without it, the login page says « code sent » and no email ever comes.
   - **Login methods**: turn on **One-time PIN**.
   - **Access policies** (or **Policies**): first look at what is already listed. If a policy is there that you did not create, delete it: only your own policies may let anyone in. Then create two policies here, inside this application:
     - The first: name `people`, action **Allow**, rule **Include** › **Emails**, and type the email address of each person who will use the app, pressing **Enter** (or typing a comma) after each one.
     - The second: name `programs`, action **Service Auth**, rule **Include** › **Service Token**, and pick both `la-table-build` and `la-table-cli`. A service token cannot go in the `people` policy: with action **Allow**, Access would ask it for a login.
   - **Overview** (or **Basic information**): copy the **Application Audience (AUD) Tag** into your notes. If you do not find it there, it is on the application's page under **Access controls** › **Applications**, on the line named **Application Audience (AUD) Tag**.
4. Save.

**Check:** open a private browser window and go to `https://la-table.<your-subdomain>.workers.dev`. You must see Cloudflare's login page asking for an email, not "Hello World!". Type an address you listed: a code arrives by email (look in the spam folder too); type it, and you reach "Hello World!". The AUD tag is 64 characters, only digits and the letters `a` to `f`.

- "Hello World!" shows without a login page: Access is not on (point 2).
- The page says « code sent » but no email comes: the public hostname or the One-time PIN method is missing (point 3).
- An address you did not list must get no code: that is Access working.

### Step 9. Put your values into your copy

Your copy still holds the values of the copy it was forked from. Six of them must become yours, in the files below; change nothing else. In particular the Worker and the database stay named `la-table`.

<!-- replace-values -->
| What | Value to find | Files that hold it |
|---|---|---|
| Account ID (step 2) | `44513f9fd94c38330fc5ca98603adf15` | `wrangler.jsonc`, `wrangler.demo.jsonc`, `probes/placeholder/wrangler.jsonc`, `probes/d1-limit/wrangler.jsonc` |
| Database ID (step 3) | `ca55d47f-86a2-40a0-bc1d-a07715071804` | `wrangler.jsonc` |
| Team domain (step 5) | `william-445.cloudflareaccess.com` | `wrangler.jsonc` |
| AUD tag (step 8) | `6e02bad1e8d730288705b85a6ff3c01332f1b51685e9ead3064971c7634cb7c3` | `wrangler.jsonc`, `.gitleaks.toml` |
| The app's address: `https://la-table.<your-subdomain>.workers.dev`, nothing after the host, no `/` at the end | `https://la-table.william-445.workers.dev` | `src/cli/client.ts` |
| Your copy's address followed by `.git`: `https://github.com/<your-name>/la-table-app.git` | `https://github.com/w2ur/la-table.git` | `scripts/deploy-ci.ts` |
<!-- /replace-values -->

**How to change a file on GitHub:**

1. On your copy's page (`https://github.com/<your-name>/la-table-app`), click through the folders to the file (for `probes/placeholder/wrangler.jsonc`: the folder `probes`, then `placeholder`, then the file).
2. Click the pencil icon (**Edit this file**), top right of the file.
3. Click inside the text, then press **Cmd+F** (Mac) or **Ctrl+F** (Windows) to open the editor's own search box, and paste the value to find.
4. Replace that value, and only it, with yours. Keep the quotes `"` around it, and every comma, exactly as they were.
5. Click **Commit changes…**, keep **Commit directly to the `main` branch**, and click **Commit changes**.

**Each file, one by one:**

1. `wrangler.jsonc` (at the top level): four values. The Account ID on the `"account_id"` line; the Database ID on the `"database_id"` line; the team domain on the `"ACCESS_TEAM_DOMAIN"` line; the AUD tag on the `"ACCESS_AUD"` line. Each appears once.
2. `wrangler.demo.jsonc`: the Account ID, on its `"account_id"` line.
3. `probes/placeholder/wrangler.jsonc`: the Account ID.
4. `probes/d1-limit/wrangler.jsonc`: the Account ID.
5. `.gitleaks.toml`: the AUD tag, on the line that starts with `regexes`, between the triple quotes `'''`. Do not touch anything else on that line: it is a search pattern, and one stray character breaks it.
6. `src/cli/client.ts`: the line `export const DEFAULT_URL = "https://la-table.william-445.workers.dev";` becomes `export const DEFAULT_URL = "https://la-table.<your-subdomain>.workers.dev";`, with your subdomain.
7. `scripts/deploy-ci.ts`: the line `export const MAIN_REMOTE = "https://github.com/w2ur/la-table.git";` becomes `export const MAIN_REMOTE = "https://github.com/<your-name>/la-table-app.git";`, with your GitHub name.

**Check:** open each file again and search each value you replaced (step 3 above): the search must find nothing. Then search for your own value: it must be there, between quotes. The Account ID must be the same in all four `wrangler.jsonc` files: the deploy's tests refuse otherwise. On a Mac, Part 2 has a command that checks all of them at once (step 14).

### Step 10. Connect the deploy (Workers Builds)

From now on, every commit to your copy's `main` branch deploys the app: Cloudflare checks it, tests it, creates or updates the database's tables, and puts it online.

1. **Workers & Pages** › `la-table` › **Settings** › **Build** › **Connect** (Git repository) ([Workers Builds settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).
2. Choose **GitHub**. Cloudflare asks to install its GitHub app: choose **Only select repositories**, pick `la-table-app`, and click **Install & Authorize**.
3. Back in Cloudflare, choose your account and the repository `la-table-app`, and set:
   - **Git branch**: `main`. **Builds for non-production branches**, if the box is shown: off (untick it).
   - **Build command**: empty. Delete whatever is in the field.
   - **Deploy command**: exactly `npm run deploy:ci`. Delete what was there first (often `npx wrangler deploy`).
   - **Preview command** (the command for non-production branches; Cloudflare fills it with `npx wrangler preview`, or `npx wrangler versions upload` on older screens): `npm run deploy:ci` too. Delete what was there first. The deploy refuses every branch but `main`, so a build on another branch then stops with nothing put online.
   - **Root directory** (or **Path**): empty, or `/`.
   - **API token**: let Cloudflare create a new one.
   - **Build variables and secrets**: add two. If the form offers a type, pick **Secret** (never **Text**):
     - name `LA_TABLE_ACCESS_CLIENT_ID`, value the `la-table-build` **Client ID** from your notes;
     - name `LA_TABLE_ACCESS_CLIENT_SECRET`, value the `la-table-build` **Client Secret**.

     Only the `la-table-build` pair goes here, never the `la-table-cli` one.
   - **Build watch paths**: leave as they are.
4. Click **Connect** (or **Save**).

A build starts on the next commit to `main`. If none appears within a few minutes under `la-table` › **Deployments** (or **Builds**), make one: on GitHub, open `README.md`, click the pencil, add an empty line at the very end, and commit it as in step 9.

**Check:** open the build under **Deployments** (or **Builds**) and read its log. It takes several minutes: it runs the tests first. It has worked when one of its last lines reads `déployé et vu derrière Access : version …` and the build is marked as successful.

**When the build fails**, look for the first line that ends with `déploiement refusé` or `impossible`, or for a `FAIL` line, and find it here. Once the cause is fixed: a fix on GitHub starts a new build by itself; a fix in the dashboard needs **Retry build** (or **Retry**) on the failed build.

- `FAIL scripts/deploy-config.test.ts`, or `configuration refusée : …`: a value of step 9 is pasted wrong (a quote or a comma lost, the Account ID different between the `wrangler.jsonc` files, an address with a `/` at the end). Redo step 9's check.
- `le compte … a le sous-domaine workers.dev …, pas …`: the address in `src/cli/client.ts` does not carry your subdomain. Fix it as in step 9.
- `Access n'est pas devant l'adresse de l'app`: Access is not on in front of the Worker. Redo step 8, point 2.
- `jeton Access absent`: the two build secrets are missing or misspelled. Redo step 10, point 3.
- `jeton Access refusé`: `la-table-build` is not in the **Service Auth** policy, its Client ID and Client Secret are swapped, or the token has expired. Check step 8's second policy and step 10's secrets.
- `le Worker la-table répond aussi sur …` or `le Worker la-table porte des secrets`: something was added to the Worker. Remove it under `la-table` › **Settings** (**Domains & Routes** for a domain or route, **Variables and Secrets** for a secret).
- `… illisible` (the subdomain, the routes and domains, or the secrets): the API token Cloudflare created for the build lacks a permission. In `la-table` › **Settings** › **Build**, let Cloudflare create a new API token, then retry.
- `point de restauration D1 impossible` or `migrations impossible`: the Database ID in `wrangler.jsonc` is wrong, or the database is not named exactly `la-table`. Redo steps 3 and 9.
- `branche … : seul main se déploie`: a build ran on another branch than `main`. Nothing to fix, as long as **Builds for non-production branches** is off.

### Step 11. On your phones

1. On each phone, open `https://la-table.<your-subdomain>.workers.dev`, type your email address, then the code you receive.
2. Add the app to the home screen. iPhone, in Safari: the **Share** button › **Add to Home Screen**. Android, in Chrome: the **⋮** menu › **Add to Home screen** (or **Install app**).

**Check:** the app opens from the home screen and shows its three tabs, **Menu**, **Courses** and **Reste**, all empty. They fill with the first planning (Part 2).

## Part 2: planning on a Mac

The planning runs in **Claude Code**, Anthropic's coding assistant, in a terminal on a Mac. It reads the app's state, proposes the week's meals from the season, the budget, recent meals and what is left at home, and writes them only when you say so. This part has been run on macOS only. On Windows, the backup that every planning takes first is, from reading its code, likely to fail, and the planning then stops: this guide does not cover Windows or Linux.

### Step 12. Open a terminal

A terminal is a window where you type (or paste) a command and press **Enter**; the computer prints the answer underneath.

- Press **Cmd+Space**, type `Terminal`, press **Enter**. A window opens with a line ending in `%` or `$`.
- Paste: **Cmd+V**. Run what you pasted: **Enter**.

Paste the commands below one line at a time, unless the guide says otherwise.

### Step 13. Install git, Node 24 and Claude Code

1. **git.** Type `git --version` and press Enter. If it prints `git version …`, go on. If a box offers to install the "command line developer tools", click **Install**, wait until it finishes, then type `git --version` again.
2. **Node 24.** The app needs Node version **24** exactly, not the newest one. Go to https://nodejs.org/en/download, choose version **24** (in the version menu, a `v24` entry; if the menu has none, open **Other downloads** or **Previous releases** and take the newest `v24`) and **macOS**, download the **macOS Installer (.pkg)**, open it and click through. Then, in a **new** terminal window (**Cmd+N**), type `node --version`. It must print a line starting with `v24.`. Another number means another version is installed: install the version 24 one again.
3. **A Claude account** with Claude Code: a Pro plan or above (https://claude.com/pricing).
4. **Claude Code.** Paste this, as Claude Code's setup page gave it in November 2026 (https://code.claude.com/docs/en/setup). It downloads Anthropic's installer and runs it at once: paste it only from that page or this guide, never from a site you do not trust.

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   Then, in a new terminal window, type `claude --version`. It must print a version number. If it says `command not found`, read the last lines the installer printed: they say what to add, or open the setup page above. If the install command itself fails, take the current one from the setup page.

### Step 14. Your copy of the code on the Mac

Paste these three lines, one at a time, replacing `<your-name>` with your GitHub name. The folder on your Mac is named `la-table`, shorter than the repository's name:

```bash
cd ~
git clone https://github.com/<your-name>/la-table-app.git la-table
cd la-table
```

Then:

```bash
npm ci
```

It downloads what the app needs, which takes a minute or two. It has worked when the last lines say `added … packages` and no line starts with `npm error`. Then check step 9 in one go:

```bash
node scripts/self-hosting-values.ts --remaining
```

It must print `every value replaced`. If it prints `still to replace: <file>: <value>`, that value is still in that file: fix it on GitHub as in step 9, then type `git pull` here and run the check again.

From now on, every command in this guide runs in this folder. A new terminal window opens in your home folder, where `la-table` now is: in each new window, first type `cd la-table`.

### Step 15. Give the planning tool its service token

The planning tool reads the `la-table-cli` token from your Mac's keychain (where macOS keeps passwords). Paste this line:

```bash
security add-generic-password -U -s la-table-access-client-id -a "$USER" -w
```

It asks for a value, twice: paste the `la-table-cli` **Client ID** and press Enter, both times. **Nothing appears while you paste**: that is normal. Then this line, with the `la-table-cli` **Client Secret**, twice as well:

```bash
security add-generic-password -U -s la-table-access-client-secret -a "$USER" -w
```

Nothing goes into the terminal's history this way. Now delete the four Client ID and Secret lines from your notes.

**Check:**

```bash
npm run plan -- status
```

It prints the app's state (empty the first time). If macOS asks whether `security` may use the keychain, click **Always Allow**.

- `jeton Access absent du trousseau (la-table-access-client-id)` (or `…-secret`): that entry is missing. Paste its line again.
- `redirigé vers la connexion Access, jeton refusé ou expiré`, or `accès refusé (403)`: `la-table-cli` is not in step 8's **Service Auth** policy, the Client ID and Secret were swapped, or one of them is the `la-table-build` one. Paste both lines again with the right values.
- `… n'est pas l'adresse de l'app` or `sous-domaine provisoire`: the address in `src/cli/client.ts` is not yours (step 9).

### Step 16. Let the backup reach your database

Every planning starts with a backup of the database, made with your Cloudflare login. Paste:

```bash
npx wrangler login
```

Your browser opens on Cloudflare: log in if asked, check that the page names the Cloudflare account of steps 2 to 10 (if you have more than one), then click **Allow**. Back in the terminal, it says you are logged in. Then:

```bash
npm run backup
```

**Check:** it ends without an error and a new file appears in the `backups` folder inside `la-table` (it stays on your Mac, never on GitHub). If it says `sauvegarde impossible`, run `npx wrangler login` again, and check you logged in to the Cloudflare account of steps 2 to 10.

### Step 17. Your first planning

1. In the terminal, in the `la-table` folder, type `claude` and press Enter. The first time, Claude Code asks you to log in to your Claude account, then whether you trust this folder: say yes.
2. Ask, in plain words: « Fais la planification de la semaine » (or "Plan this week's meals").
3. Claude Code follows the project's planning instructions: it takes the backup, reads the state, asks you how many meals and how many portions, and proposes a list with prices. Ask for changes as often as you like.
4. When it asks to run a command (`npm run plan -- …` or `npm run backup`), allow it.
5. Nothing is written until you give your go (« ok », « on valide »). Then the meals appear on the phones under **Menu**, and what to buy under **Courses**.

The first time, it may offer to record what you already have at home (oil, spices, rice): tell it, and it writes them into **Reste**.

## Afterwards

### Keeping the app up to date

When the copy you forked from changes, bring the changes into yours:

1. Before each update, on the Mac, in a new terminal window: `cd la-table`, then `npm run backup`.
2. On your copy's GitHub page, click **Sync fork** › **Update branch**. This is a commit to `main`, so it deploys (step 10's check applies).
3. On the Mac: `git pull`, then `npm ci`.

If GitHub says the update has **conflicts**, never click **Discard commits**: that would erase your values. A conflict means the original changed a line that holds one of your step-9 values. Choose **Open pull request**, then **Resolve conflicts**. In each block GitHub marks between `<<<<<<<` and `>>>>>>>`, keep your line (with your value), delete the other line and the three marker lines (`<<<<<<< …`, `=======`, `>>>>>>> …`), then **Mark as resolved**, **Commit merge**, and **Merge pull request** (from knowledge of GitHub, not tried on this repository). If any screen looks different from this description, stop and click nothing more: close the page, and your app keeps running on its current version. Then run step 14's check again on the Mac, after `git pull`.

### Backups

- Every planning takes one first (`npm run backup`), into the `backups` folder inside `la-table`. If it fails, the planning stops: no planning without a backup.
- Now and then, `npm run restore-drill` restores the newest backup into a scratch copy on your Mac and checks that nothing is missing. It touches nothing online.
- Every deploy also writes a restore point in its log, on the line starting with `point de restauration D1 :`, which holds a `bookmark`. To bring the online database back to that moment: `npx wrangler d1 time-travel restore la-table --bookmark=<bookmark>` (from knowledge of wrangler: read `npx wrangler d1 time-travel restore --help` first). This replaces everything written since.

### Adding or removing a person

In Zero Trust › **Access controls** › **Applications** › your application › **Access policies** › `people`: add or remove an email address and save. Nothing else changes.

### Stopping everything

In Cloudflare: delete the Worker `la-table` (**Workers & Pages** › `la-table` › **Settings** › **Delete**), the database (**D1 SQL Database** › `la-table` › **Settings** › **Delete**; take a backup first if you want to keep the data), the Access application and the two service tokens in Zero Trust, and the API token Cloudflare created for the build in step 10 (it stays valid after the Worker is gone: **My Profile** › **API Tokens**, the token named after the Worker's builds, **Delete**). On GitHub: your copy's **Settings** › **Delete this repository**, then your account's **Settings** › **Applications** › **Installed GitHub Apps** › **Cloudflare Workers and Pages** › **Configure** › **Uninstall**. On the Mac: delete the `la-table` folder in your home folder, and the two keychain entries with `security delete-generic-password -s la-table-access-client-id` and `security delete-generic-password -s la-table-access-client-secret`.

---

<a id="français"></a>

## Français

Ce guide met en ligne votre propre exemplaire de La Table, sur votre propre compte Cloudflare, pour deux personnes. Il suppose que vous n'avez jamais utilisé de terminal ni GitHub : chaque étape dit où cliquer, quoi copier, et comment vérifier que cela a marché. Si le terminal et git vous sont familiers, le guide plus court [SELF-HOSTING.md](SELF-HOSTING.md) couvre le même terrain. Retour au [README](README.md).

À la fin, vous aurez :

- votre propre adresse web, `https://la-table.<votre-sous-domaine>.workers.dev`, qui demande une adresse électronique et ne laisse entrer que les personnes que vous avez listées, avec un code envoyé par courriel ;
- votre propre base de données, dont seul votre exemplaire se sert ;
- une application à ajouter à l'écran d'accueil de votre téléphone ;
- sur un Mac, une séance de planification avec Claude Code, qui remplit les repas et la liste de courses de la semaine.

L'application est en français. Ses trois listes sont **Menu** (les repas), **Courses** (les achats, par rayon) et **Reste** (ce qui reste à la maison).

**À lire avant de commencer.** Les repas et la liste de courses ne viennent que de la séance de planification (deuxième partie), qui demande un Mac et un abonnement Claude payant. Les téléphones lisent et cochent les listes ; ils peuvent ajouter un achat ou une chose trouvée à la maison, jamais un repas. Sans la deuxième partie, l'application reste vide.

### Ce que cela coûte

| Service | Son rôle ici | Prix |
|---|---|---|
| GitHub | garde votre exemplaire du code | compte gratuit |
| Cloudflare | fait tourner l'application, sa base et sa connexion | offres gratuites : Workers Free, D1, Workers Builds, Zero Trust Free |
| Claude (deuxième partie) | fait tourner la planification dans Claude Code | une offre payante : Claude Code demande l'offre Pro ou au-dessus, ou un compte Anthropic Console ; l'offre gratuite ne le comprend pas |

L'inscription à Zero Trust de Cloudflare demande un moyen de paiement même pour l'offre gratuite ; rien n'est prélevé (page de mise en route de Cloudflare, vérifiée le 15 novembre 2026). Les fournisseurs changent leurs prix et leurs limites : consultez https://claude.com/pricing et la page des offres de Cloudflare avant de commencer.

### Ce qui protège l'application

Cloudflare Access, rien d'autre. N'importe qui peut connaître l'adresse : un visiteur sans session tombe sur la page de connexion de Cloudflare, qui n'envoie un code qu'aux adresses électroniques que vous avez listées. Votre exemplaire du code est public sur GitHub, et c'est sans danger : les valeurs que vous y mettrez (l'identifiant de votre compte, celui de votre base, votre domaine d'équipe et votre étiquette AUD Access, votre adresse) ne sont pas des secrets. Les secrets sont votre mot de passe Cloudflare et les deux **jetons de service** de l'étape 7. **Ne mettez jamais un jeton de service sur GitHub.**

### Avant de commencer

**Les mots que vous croiserez :**

- **Dépôt** (*repository*, ou *repo*) : un dossier de code conservé sur GitHub.
- **Fourche** (*fork*) : votre propre copie du dépôt de quelqu'un d'autre, sur votre compte GitHub.
- **Commit** : une modification enregistrée dans un dépôt. Sur GitHub, on la fait avec le bouton **Commit changes**.
- **Worker** : un petit programme que Cloudflare fait tourner pour vous ; La Table en est un, nommé `la-table`.
- **Déployer** : mettre le code en ligne, pour qu'il tourne comme un site.
- **Access** : la barrière de connexion de Cloudflare devant le Worker.
- **Jeton de service** : une paire de valeurs (un **Client ID** et un **Client Secret**) qui laisse passer un programme, pas une personne, à travers Access.
- **Terminal** : une fenêtre où l'on tape des commandes au lieu de cliquer. Il ne sert que dans la deuxième partie.

**Ouvrez un fichier de notes privé** sur votre ordinateur (un document texte que vous seul voyez) et collez-y ceci. Vous le remplirez au fil des étapes :

```
Account ID =
workers.dev subdomain =
Database ID =
Team domain =
AUD tag =
la-table-build Client ID =
la-table-build Client Secret =
la-table-cli Client ID =
la-table-cli Client Secret =
```

Les deux Client Secret sont des mots de passe. **Ne publiez jamais cette note et ne la mettez jamais sur GitHub.** Une fois les deux jetons à leur place définitive (étapes 10 et 15), effacez de la note les quatre lignes de Client ID et de Client Secret : si vous en perdez un plus tard, vous créerez un nouveau jeton.

**Utilisez un seul navigateur pour la première partie**, sur un ordinateur plutôt qu'un téléphone. Les libellés ci-dessous restent en anglais, comme à l'écran. Ceux de Cloudflare ont été vérifiés le 15 novembre 2026 sur sa documentation, pas sur un tableau de bord réel ; Cloudflare et GitHub les renomment de temps à autre. Quand un libellé diffère, cherchez le plus proche : la page de documentation liée à l'étape fait foi.

## Première partie : l'application en ligne (tout ordinateur, navigateur seul)

### Étape 1. Créer un compte GitHub et faire votre copie

1. Allez sur https://github.com/signup et créez un compte. Confirmez votre adresse électronique quand GitHub le demande.
2. Allez sur https://github.com/w2ur/la-table-app et cliquez sur **Fork** (en haut à droite).
3. Gardez le propriétaire (votre compte) et le nom `la-table-app`, laissez cochée **Copy the main branch only**, et cliquez sur **Create fork**. La copie peut mettre une minute à apparaître. Si votre compte a déjà un dépôt nommé `la-table-app`, GitHub refuse le nom : renommez d'abord l'ancien (ses **Settings** › **Repository name**), pour que chaque `la-table-app` de ce guide reste juste.

**Vérification :** la page affiche maintenant `<votre-nom>/la-table-app` en haut à gauche, avec « forked from w2ur/la-table-app » dessous. Notez l'adresse de votre copie, `https://github.com/<votre-nom>/la-table-app`.

### Étape 2. Créer un compte Cloudflare, votre sous-domaine et votre identifiant de compte

1. Allez sur https://dash.cloudflare.com/sign-up et créez un compte. Confirmez votre adresse électronique. Cloudflare recommande d'activer dès maintenant la double authentification, dans les réglages d'authentification de votre profil : ce compte tiendra votre application et sa connexion.
2. Dans le menu de gauche, ouvrez **Workers & Pages** (parfois sous **Compute (Workers)**). La première fois, Cloudflare vous demande de choisir un **sous-domaine workers.dev** : un nom court à vous, en minuscules, chiffres et tirets. Choisissez-le et confirmez.
3. Sur la page **Workers & Pages**, la colonne de droite affiche votre **Account ID** et votre sous-domaine (`<votre-sous-domaine>.workers.dev`). S'il n'y est pas, la page d'accueil du compte a un menu (**⋯** à côté du nom du compte) avec **Copy account ID**.
4. Collez les deux dans vos notes : l'Account ID, et le sous-domaine seul (sans `.workers.dev`).

**Vérification :** l'Account ID compte 32 caractères, uniquement des chiffres et les lettres `a` à `f`. Désormais, chaque `<votre-sous-domaine>` de ce guide désigne le nom que vous avez choisi.

### Étape 3. Créer la base de données

1. Dans le menu de gauche, ouvrez **Storage & Databases** › **D1 SQL Database**, puis **Create database** (ou **Create**).
2. Nommez-la exactement `la-table`. Laissez l'emplacement tel quel. Cliquez sur **Create**.
3. La page de la base affiche son **Database ID**, 36 caractères en cinq groupes séparés par des tirets. Copiez-le dans vos notes.

Ne créez aucune table : le premier déploiement s'en charge (étape 10).

**Vérification :** la liste sous **D1 SQL Database** montre une base nommée `la-table`.

### Étape 4. Créer un Worker provisoire nommé `la-table`

Access se pose sur un Worker qui existe déjà, et le vrai déploiement refuse de tourner tant qu'il ne voit pas Access devant l'adresse. Vous créez donc d'abord un Worker provisoire sous le nom de l'application ; le premier déploiement le remplace.

1. **Workers & Pages** › **Create** (ou **Create application**) › sur l'onglet **Workers**, **Start with Hello World!** (ou le modèle **Hello World**).
2. Le champ du nom est prérempli d'un nom tiré au hasard : remplacez-le par exactement `la-table`. Cliquez sur **Deploy**.
3. N'y ajoutez rien : ni domaine, ni route, ni variable, ni secret. Le déploiement refuse un Worker qui en a un.

**Vérification :** ouvrez `https://la-table.<votre-sous-domaine>.workers.dev` dans un nouvel onglet. La page affiche « Hello World! ». Un sous-domaine tout neuf peut mettre quelques minutes à répondre ; si la page ne se charge pas, attendez et réessayez. Jusqu'à l'étape 8, tout le monde peut voir cette page, sans danger : elle ne contient rien.

### Étape 5. Activer Zero Trust et noter votre domaine d'équipe

1. Dans le menu de gauche, ouvrez **Zero Trust**. La première fois, Cloudflare demande un **nom d'équipe** (*team name*) : choisissez-en un (minuscules, chiffres, tirets). Votre **domaine d'équipe** devient `<nom-d-équipe>.cloudflareaccess.com`.
2. Choisissez l'offre **Free** et terminez l'inscription. Elle demande un moyen de paiement même pour Free, sans rien prélever (voir « Ce que cela coûte » ; [mise en route de Zero Trust](https://developers.cloudflare.com/cloudflare-one/setup/)).
3. Collez le domaine d'équipe, `<nom-d-équipe>.cloudflareaccess.com`, dans vos notes.

**Vérification :** vous êtes dans le tableau de bord Zero Trust, avec son propre menu de gauche (**Access**, **Settings** et d'autres). Si vous avez oublié le domaine d'équipe, il figure sous **Settings** (puis **General** ou **Custom Pages**) : cherchez le nom qui finit par `.cloudflareaccess.com`.

### Étape 6. Activer le code à usage unique par courriel

Les nouveaux comptes Zero Trust n'ont plus cette méthode d'office ([One-time PIN](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)).

1. Dans Zero Trust : **Integrations** › **Identity providers** › **Add new identity provider**.
2. Choisissez **One-time PIN** et enregistrez.

**Vérification :** **Your identity providers** affiche **One-time PIN**.

### Étape 7. Créer les deux jetons de service

Deux programmes doivent passer Access sans personne derrière : le déploiement (`la-table-build`) et l'outil de planification sur votre Mac (`la-table-cli`). Chacun a son propre jeton.

1. Dans Zero Trust : **Access controls** › **Service credentials** › **Service Tokens** › **Create Service Token** ([jetons de service](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)).
2. Nommez-le `la-table-build`. Choisissez une durée : la plus longue proposée ; mettez un rappel dans votre agenda une semaine avant la fin (un jeton expiré arrête le déploiement sur « jeton Access refusé »). Pour le prolonger alors, ouvrez le jeton et cliquez sur **Refresh** (une année de plus), ou sur **Edit** pour choisir une durée plus longue. Cliquez sur **Generate token**.
3. Cloudflare affiche le **Client ID** et le **Client Secret** une seule fois, jamais plus. Copiez chacun dans vos notes, sur les lignes `la-table-build`. S'ils s'affichent sous la forme `CF-Access-Client-Id: xxxx` et `CF-Access-Client-Secret: xxxx`, ne copiez que ce qui suit les deux-points et l'espace.
4. Cliquez sur **Save**.
5. Recommencez avec le nom `la-table-cli`, sur les lignes `la-table-cli`.

**Vérification :** les Client ID finissent par `.access` ; un Client Secret est une longue suite de caractères, qui commence le plus souvent par `cfast_` (les plus anciens font 64 chiffres et lettres de `a` à `f`). **Service Tokens** liste `la-table-build` et `la-table-cli`. Si vous avez fermé la page avant de copier un secret, supprimez ce jeton et créez-le de nouveau.

### Étape 8. Mettre Access devant le Worker

1. De retour dans le tableau de bord principal de Cloudflare : **Workers & Pages** › `la-table` › **Settings** › **Domains & Routes**.
2. Sur la ligne `workers.dev`, activez **Cloudflare Access** (un interrupteur, ou le menu **⋯** › **Enable Cloudflare Access**), et confirmez. Cela crée une **application** Access pour le Worker. Si une ligne pour les adresses de prévisualisation s'affiche aussi, laissez-la : l'application n'en a pas.
3. Dans Zero Trust : **Access controls** › **Applications**. Ouvrez la nouvelle application (son nom contient `la-table`) et choisissez **Edit** (ou **Configure**). Sur ses pages :
   - **Destinations** (ou **Public hostname**) : ajoutez le nom d'hôte public `la-table.<votre-sous-domaine>.workers.dev` (sous-domaine `la-table`, domaine `<votre-sous-domaine>.workers.dev`, sans chemin). Sans lui, la page de connexion dit « code envoyé » et aucun courriel n'arrive jamais.
   - **Login methods** : activez **One-time PIN**.
   - **Access policies** (ou **Policies**) : regardez d'abord ce qui est déjà listé. Si une règle s'y trouve que vous n'avez pas créée, supprimez-la : seules vos propres règles doivent laisser entrer quelqu'un. Créez ensuite deux règles ici, dans cette application :
     - La première : nom `people`, action **Allow**, règle **Include** › **Emails**, et tapez l'adresse électronique de chaque personne qui se servira de l'application, en appuyant sur **Entrée** (ou en tapant une virgule) après chacune.
     - La seconde : nom `programs`, action **Service Auth**, règle **Include** › **Service Token**, et choisissez `la-table-build` et `la-table-cli`. Un jeton de service ne peut pas aller dans la règle `people` : avec l'action **Allow**, Access lui demanderait une connexion.
   - **Overview** (ou **Basic information**) : copiez l'**Application Audience (AUD) Tag** dans vos notes. Si vous ne le trouvez pas là, il est sur la page de l'application sous **Access controls** › **Applications**, à la ligne nommée **Application Audience (AUD) Tag**.
4. Enregistrez.

**Vérification :** ouvrez une fenêtre de navigation privée et allez sur `https://la-table.<votre-sous-domaine>.workers.dev`. Vous devez voir la page de connexion de Cloudflare qui demande une adresse électronique, et non « Hello World! ». Tapez une adresse que vous avez listée : un code arrive par courriel (regardez aussi dans les indésirables) ; tapez-le, et vous arrivez sur « Hello World! ». L'étiquette AUD compte 64 caractères, uniquement des chiffres et les lettres `a` à `f`.

- « Hello World! » s'affiche sans page de connexion : Access n'est pas activé (point 2).
- La page dit « code envoyé » mais aucun courriel n'arrive : il manque le nom d'hôte public ou la méthode One-time PIN (point 3).
- Une adresse que vous n'avez pas listée ne doit recevoir aucun code : c'est Access qui fonctionne.

### Étape 9. Mettre vos valeurs dans votre copie

Votre copie contient encore les valeurs de l'exemplaire d'où elle vient. Six d'entre elles doivent devenir les vôtres, dans les fichiers ci-dessous ; ne changez rien d'autre. En particulier, le Worker et la base restent nommés `la-table`.

<!-- replace-values -->
| Quoi | Valeur à trouver | Fichiers qui la portent |
|---|---|---|
| Account ID (étape 2) | `44513f9fd94c38330fc5ca98603adf15` | `wrangler.jsonc`, `wrangler.demo.jsonc`, `probes/placeholder/wrangler.jsonc`, `probes/d1-limit/wrangler.jsonc` |
| Database ID (étape 3) | `ca55d47f-86a2-40a0-bc1d-a07715071804` | `wrangler.jsonc` |
| Domaine d'équipe (étape 5) | `william-445.cloudflareaccess.com` | `wrangler.jsonc` |
| Étiquette AUD (étape 8) | `6e02bad1e8d730288705b85a6ff3c01332f1b51685e9ead3064971c7634cb7c3` | `wrangler.jsonc`, `.gitleaks.toml` |
| L'adresse de l'application : `https://la-table.<votre-sous-domaine>.workers.dev`, rien après l'hôte, pas de `/` à la fin | `https://la-table.william-445.workers.dev` | `src/cli/client.ts` |
| L'adresse de votre copie suivie de `.git` : `https://github.com/<votre-nom>/la-table-app.git` | `https://github.com/w2ur/la-table.git` | `scripts/deploy-ci.ts` |
<!-- /replace-values -->

**Modifier un fichier sur GitHub :**

1. Sur la page de votre copie (`https://github.com/<votre-nom>/la-table-app`), cliquez de dossier en dossier jusqu'au fichier (pour `probes/placeholder/wrangler.jsonc` : le dossier `probes`, puis `placeholder`, puis le fichier).
2. Cliquez sur l'icône du crayon (**Edit this file**), en haut à droite du fichier.
3. Cliquez dans le texte, puis appuyez sur **Cmd+F** (Mac) ou **Ctrl+F** (Windows) pour ouvrir la recherche propre à l'éditeur, et collez la valeur à trouver.
4. Remplacez cette valeur, et elle seule, par la vôtre. Gardez les guillemets `"` qui l'entourent, et chaque virgule, exactement comme ils étaient.
5. Cliquez sur **Commit changes…**, gardez **Commit directly to the `main` branch**, et cliquez sur **Commit changes**.

**Chaque fichier, un par un :**

1. `wrangler.jsonc` (au premier niveau) : quatre valeurs. L'Account ID sur la ligne `"account_id"` ; le Database ID sur la ligne `"database_id"` ; le domaine d'équipe sur la ligne `"ACCESS_TEAM_DOMAIN"` ; l'étiquette AUD sur la ligne `"ACCESS_AUD"`. Chacune n'y figure qu'une fois.
2. `wrangler.demo.jsonc` : l'Account ID, sur sa ligne `"account_id"`.
3. `probes/placeholder/wrangler.jsonc` : l'Account ID.
4. `probes/d1-limit/wrangler.jsonc` : l'Account ID.
5. `.gitleaks.toml` : l'étiquette AUD, sur la ligne qui commence par `regexes`, entre les triples apostrophes `'''`. Ne touchez à rien d'autre sur cette ligne : c'est un motif de recherche, et un seul caractère de trop le casse.
6. `src/cli/client.ts` : la ligne `export const DEFAULT_URL = "https://la-table.william-445.workers.dev";` devient `export const DEFAULT_URL = "https://la-table.<votre-sous-domaine>.workers.dev";`, avec votre sous-domaine.
7. `scripts/deploy-ci.ts` : la ligne `export const MAIN_REMOTE = "https://github.com/w2ur/la-table.git";` devient `export const MAIN_REMOTE = "https://github.com/<votre-nom>/la-table-app.git";`, avec votre nom GitHub.

**Vérification :** rouvrez chaque fichier et cherchez chaque valeur remplacée (point 3 ci-dessus) : la recherche ne doit rien trouver. Cherchez ensuite votre propre valeur : elle doit y être, entre guillemets. L'Account ID doit être le même dans les quatre fichiers `wrangler.jsonc` : les tests du déploiement refusent sinon. Sur un Mac, la deuxième partie a une commande qui les vérifie toutes d'un coup (étape 14).

### Étape 10. Brancher le déploiement (Workers Builds)

Désormais, chaque commit sur la branche `main` de votre copie déploie l'application : Cloudflare la vérifie, la teste, crée ou met à jour les tables de la base, et la met en ligne.

1. **Workers & Pages** › `la-table` › **Settings** › **Build** › **Connect** (dépôt Git) ([réglages de Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).
2. Choisissez **GitHub**. Cloudflare demande d'installer son application GitHub : choisissez **Only select repositories**, prenez `la-table-app`, et cliquez sur **Install & Authorize**.
3. De retour sur Cloudflare, choisissez votre compte et le dépôt `la-table-app`, puis réglez :
   - **Git branch** : `main`. **Builds for non-production branches**, si la case s'affiche : désactivé (décochez-la).
   - **Build command** : vide. Effacez ce que contient le champ.
   - **Deploy command** : exactement `npm run deploy:ci`. Effacez d'abord ce qui s'y trouvait (souvent `npx wrangler deploy`).
   - **Preview command** (la commande des autres branches ; Cloudflare y met `npx wrangler preview`, ou `npx wrangler versions upload` sur les écrans plus anciens) : `npm run deploy:ci` aussi. Effacez d'abord ce qui s'y trouvait. Le déploiement refuse toute autre branche que `main` : une construction sur une autre branche s'arrête alors sans rien mettre en ligne.
   - **Root directory** (ou **Path**) : vide, ou `/`.
   - **API token** : laissez Cloudflare en créer un nouveau.
   - **Build variables and secrets** : ajoutez-en deux. Si le formulaire propose un type, choisissez **Secret** (jamais **Text**) :
     - nom `LA_TABLE_ACCESS_CLIENT_ID`, valeur le **Client ID** de `la-table-build` pris dans vos notes ;
     - nom `LA_TABLE_ACCESS_CLIENT_SECRET`, valeur le **Client Secret** de `la-table-build`.

     Seule la paire de `la-table-build` va ici, jamais celle de `la-table-cli`.
   - **Build watch paths** : laissez tel quel.
4. Cliquez sur **Connect** (ou **Save**).

Une construction démarre au prochain commit sur `main`. Si aucune n'apparaît sous `la-table` › **Deployments** (ou **Builds**) au bout de quelques minutes, faites-en un : sur GitHub, ouvrez `README.md`, cliquez sur le crayon, ajoutez une ligne vide tout à la fin, et validez comme à l'étape 9.

**Vérification :** ouvrez la construction sous **Deployments** (ou **Builds**) et lisez son journal. Elle dure plusieurs minutes : elle lance d'abord les tests. Elle a réussi quand l'une de ses dernières lignes dit `déployé et vu derrière Access : version …` et que la construction est marquée réussie.

**Quand la construction échoue**, cherchez la première ligne qui finit par `déploiement refusé` ou `impossible`, ou une ligne `FAIL`, et retrouvez-la ici. Une fois la cause réglée : une correction sur GitHub relance une construction d'elle-même ; une correction dans le tableau de bord demande **Retry build** (ou **Retry**) sur la construction échouée.

- `FAIL scripts/deploy-config.test.ts`, ou `configuration refusée : …` : une valeur de l'étape 9 est mal collée (un guillemet ou une virgule perdus, l'Account ID différent d'un fichier `wrangler.jsonc` à l'autre, une adresse finie par `/`). Refaites la vérification de l'étape 9.
- `le compte … a le sous-domaine workers.dev …, pas …` : l'adresse de `src/cli/client.ts` ne porte pas votre sous-domaine. Corrigez-la comme à l'étape 9.
- `Access n'est pas devant l'adresse de l'app` : Access n'est pas activé devant le Worker. Refaites l'étape 8, point 2.
- `jeton Access absent` : les deux secrets de construction manquent ou sont mal orthographiés. Refaites l'étape 10, point 3.
- `jeton Access refusé` : `la-table-build` n'est pas dans la règle **Service Auth**, son Client ID et son Client Secret sont intervertis, ou le jeton a expiré. Vérifiez la seconde règle de l'étape 8 et les secrets de l'étape 10.
- `le Worker la-table répond aussi sur …` ou `le Worker la-table porte des secrets` : quelque chose a été ajouté au Worker. Retirez-le sous `la-table` › **Settings** (**Domains & Routes** pour un domaine ou une route, **Variables and Secrets** pour un secret).
- `… illisible` (le sous-domaine, les routes et domaines, ou les secrets) : il manque une permission au jeton d'API que Cloudflare a créé pour la construction. Dans `la-table` › **Settings** › **Build**, laissez Cloudflare créer un nouveau jeton d'API, puis relancez.
- `point de restauration D1 impossible` ou `migrations impossible` : le Database ID de `wrangler.jsonc` est faux, ou la base ne s'appelle pas exactement `la-table`. Refaites les étapes 3 et 9.
- `branche … : seul main se déploie` : une construction a tourné sur une autre branche que `main`. Rien à corriger, tant que **Builds for non-production branches** reste désactivé.

### Étape 11. Sur vos téléphones

1. Sur chaque téléphone, ouvrez `https://la-table.<votre-sous-domaine>.workers.dev`, tapez votre adresse électronique, puis le code reçu.
2. Ajoutez l'application à l'écran d'accueil. iPhone, dans Safari : le bouton **Partager** › **Sur l'écran d'accueil**. Android, dans Chrome : le menu **⋮** › **Ajouter à l'écran d'accueil** (ou **Installer l'application**).

**Vérification :** l'application s'ouvre depuis l'écran d'accueil et montre ses trois onglets, **Menu**, **Courses** et **Reste**, tous vides. Ils se remplissent à la première planification (deuxième partie).

## Deuxième partie : planifier sur un Mac

La planification se fait dans **Claude Code**, l'assistant de programmation d'Anthropic, dans un terminal sur un Mac. Il lit l'état de l'application, propose les repas de la semaine selon la saison, le budget, les repas récents et ce qui reste à la maison, et ne les écrit que sur votre accord. Cette partie n'a tourné que sur macOS. Sous Windows, la sauvegarde que chaque planification fait d'abord échouera probablement, d'après la lecture de son code, et la planification s'arrête alors : ce guide ne couvre ni Windows ni Linux.

### Étape 12. Ouvrir un terminal

Un terminal est une fenêtre où l'on tape (ou colle) une commande, puis **Entrée** ; l'ordinateur affiche la réponse dessous.

- Appuyez sur **Cmd+Espace**, tapez `Terminal`, appuyez sur **Entrée**. Une fenêtre s'ouvre, avec une ligne qui finit par `%` ou `$`.
- Coller : **Cmd+V**. Lancer ce que vous avez collé : **Entrée**.

Collez les commandes ci-dessous une ligne à la fois, sauf quand le guide dit autrement.

### Étape 13. Installer git, Node 24 et Claude Code

1. **git.** Tapez `git --version` puis Entrée. S'il affiche `git version …`, continuez. Si une fenêtre propose d'installer les « outils de développement en ligne de commande », cliquez sur **Installer**, attendez la fin, puis tapez de nouveau `git --version`.
2. **Node 24.** L'application demande la version **24** de Node exactement, pas la plus récente. Allez sur https://nodejs.org/en/download, choisissez la version **24** (dans le menu des versions, une entrée `v24` ; si le menu n'en a pas, ouvrez **Other downloads** ou **Previous releases** et prenez la plus récente `v24`) et **macOS**, téléchargez le **macOS Installer (.pkg)**, ouvrez-le et suivez-le jusqu'au bout. Puis, dans une **nouvelle** fenêtre de terminal (**Cmd+N**), tapez `node --version`. La réponse doit commencer par `v24.`. Un autre numéro veut dire qu'une autre version est installée : réinstallez celle de la version 24.
3. **Un compte Claude** avec Claude Code : l'offre Pro ou au-dessus (https://claude.com/pricing).
4. **Claude Code.** Collez ceci, tel que la page d'installation de Claude Code le donnait en novembre 2026 (https://code.claude.com/docs/en/setup). La commande télécharge l'installateur d'Anthropic et le lance aussitôt : ne la collez que depuis cette page ou ce guide, jamais depuis un site dont vous n'êtes pas sûr.

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   Puis, dans une nouvelle fenêtre de terminal, tapez `claude --version`. La réponse doit être un numéro de version. Si elle dit `command not found`, lisez les dernières lignes affichées par l'installation : elles disent quoi ajouter ; sinon, ouvrez la page d'installation ci-dessus. Si la commande d'installation elle-même échoue, prenez celle du jour sur la page d'installation.

### Étape 14. Votre copie du code sur le Mac

Collez ces trois lignes, une à la fois, en remplaçant `<votre-nom>` par votre nom GitHub. Le dossier sur votre Mac s'appelle `la-table`, plus court que le nom du dépôt :

```bash
cd ~
git clone https://github.com/<votre-nom>/la-table-app.git la-table
cd la-table
```

Puis :

```bash
npm ci
```

Cela télécharge ce dont l'application a besoin, en une minute ou deux. C'est réussi quand les dernières lignes disent `added … packages` et qu'aucune ligne ne commence par `npm error`. Vérifiez ensuite l'étape 9 d'un coup :

```bash
node scripts/self-hosting-values.ts --remaining
```

La réponse doit être `every value replaced`. Si elle affiche `still to replace: <fichier>: <valeur>`, cette valeur est encore dans ce fichier : corrigez-la sur GitHub comme à l'étape 9, puis tapez `git pull` ici et relancez la vérification.

Désormais, chaque commande de ce guide se lance dans ce dossier. Une nouvelle fenêtre de terminal s'ouvre dans votre dossier personnel, où se trouve désormais `la-table` : dans chaque nouvelle fenêtre, tapez d'abord `cd la-table`.

### Étape 15. Donner son jeton de service à l'outil de planification

L'outil de planification lit le jeton `la-table-cli` dans le trousseau de votre Mac (là où macOS garde les mots de passe). Collez cette ligne :

```bash
security add-generic-password -U -s la-table-access-client-id -a "$USER" -w
```

Elle demande une valeur, deux fois : collez le **Client ID** de `la-table-cli` puis Entrée, les deux fois. **Rien ne s'affiche pendant que vous collez** : c'est normal. Puis cette ligne, avec le **Client Secret** de `la-table-cli`, deux fois aussi :

```bash
security add-generic-password -U -s la-table-access-client-secret -a "$USER" -w
```

Ainsi, rien n'entre dans l'historique du terminal. Effacez maintenant de vos notes les quatre lignes de Client ID et de Client Secret.

**Vérification :**

```bash
npm run plan -- status
```

La réponse est l'état de l'application (vide la première fois). Si macOS demande si `security` peut utiliser le trousseau, cliquez sur **Toujours autoriser**.

- `jeton Access absent du trousseau (la-table-access-client-id)` (ou `…-secret`) : cette entrée manque. Recollez sa ligne.
- `redirigé vers la connexion Access, jeton refusé ou expiré`, ou `accès refusé (403)` : `la-table-cli` n'est pas dans la règle **Service Auth** de l'étape 8, le Client ID et le Secret ont été intervertis, ou l'un d'eux est celui de `la-table-build`. Recollez les deux lignes avec les bonnes valeurs.
- `… n'est pas l'adresse de l'app` ou `sous-domaine provisoire` : l'adresse de `src/cli/client.ts` n'est pas la vôtre (étape 9).

### Étape 16. Laisser la sauvegarde atteindre votre base

Chaque planification commence par une sauvegarde de la base, faite avec votre connexion Cloudflare. Collez :

```bash
npx wrangler login
```

Votre navigateur s'ouvre sur Cloudflare : connectez-vous si on vous le demande, vérifiez que la page nomme le compte Cloudflare des étapes 2 à 10 (si vous en avez plusieurs), puis cliquez sur **Allow**. De retour dans le terminal, il dit que vous êtes connecté. Puis :

```bash
npm run backup
```

**Vérification :** elle se termine sans erreur et un nouveau fichier apparaît dans le dossier `backups` de `la-table` (il reste sur votre Mac, jamais sur GitHub). Si elle dit `sauvegarde impossible`, relancez `npx wrangler login`, et vérifiez que vous vous êtes connecté au compte Cloudflare des étapes 2 à 10.

### Étape 17. Votre première planification

1. Dans le terminal, dans le dossier `la-table`, tapez `claude` puis Entrée. La première fois, Claude Code vous demande de vous connecter à votre compte Claude, puis si vous faites confiance à ce dossier : répondez oui.
2. Demandez, en toutes lettres : « Fais la planification de la semaine ».
3. Claude Code suit les instructions de planification du projet : il fait la sauvegarde, lit l'état, vous demande combien de repas et combien de portions, et propose une liste avec ses prix. Demandez des changements aussi souvent que vous voulez.
4. Quand il demande à lancer une commande (`npm run plan -- …` ou `npm run backup`), autorisez-la.
5. Rien n'est écrit avant votre accord (« ok », « on valide »). Les repas apparaissent alors sur les téléphones sous **Menu**, et ce qu'il faut acheter sous **Courses**.

La première fois, il peut proposer de noter ce que vous avez déjà à la maison (huile, épices, riz) : dites-le-lui, il l'écrit dans **Reste**.

## Ensuite

### Garder l'application à jour

Quand l'exemplaire d'où vient votre copie change, rapatriez les changements :

1. Avant chaque mise à jour, sur le Mac, dans une nouvelle fenêtre de terminal : `cd la-table`, puis `npm run backup`.
2. Sur la page GitHub de votre copie, cliquez sur **Sync fork** › **Update branch**. C'est un commit sur `main` : il déploie (la vérification de l'étape 10 vaut).
3. Sur le Mac : `git pull`, puis `npm ci`.

Si GitHub signale des **conflits**, ne cliquez jamais sur **Discard commits** : vos valeurs seraient effacées. Un conflit veut dire que l'original a changé une ligne qui porte l'une de vos valeurs de l'étape 9. Choisissez **Open pull request**, puis **Resolve conflicts**. Dans chaque bloc que GitHub marque entre `<<<<<<<` et `>>>>>>>`, gardez votre ligne (avec votre valeur), effacez l'autre ligne et les trois lignes de marque (`<<<<<<< …`, `=======`, `>>>>>>> …`), puis **Mark as resolved**, **Commit merge**, et **Merge pull request** (d'après ce que je sais de GitHub, non essayé sur ce dépôt). Si un écran ne ressemble pas à cette description, arrêtez-vous et ne cliquez plus sur rien : fermez la page, et votre application continue de tourner sur sa version actuelle. Relancez ensuite la vérification de l'étape 14 sur le Mac, après `git pull`.

### Sauvegardes

- Chaque planification en fait une d'abord (`npm run backup`), dans le dossier `backups` de `la-table`. Si elle échoue, la planification s'arrête : pas de planification sans sauvegarde.
- De temps à autre, `npm run restore-drill` restaure la sauvegarde la plus récente dans une copie jetable sur votre Mac et vérifie que rien ne manque. Il ne touche à rien en ligne.
- Chaque déploiement écrit aussi un point de restauration dans son journal, sur la ligne qui commence par `point de restauration D1 :`, qui contient un `bookmark`. Pour ramener la base en ligne à ce moment-là : `npx wrangler d1 time-travel restore la-table --bookmark=<bookmark>` (d'après ce que je sais de wrangler : lisez d'abord `npx wrangler d1 time-travel restore --help`). Cela remplace tout ce qui a été écrit depuis.

### Ajouter ou retirer une personne

Dans Zero Trust › **Access controls** › **Applications** › votre application › **Access policies** › `people` : ajoutez ou retirez une adresse électronique et enregistrez. Rien d'autre ne change.

### Tout arrêter

Dans Cloudflare : supprimez le Worker `la-table` (**Workers & Pages** › `la-table` › **Settings** › **Delete**), la base (**D1 SQL Database** › `la-table` › **Settings** › **Delete** ; faites d'abord une sauvegarde si vous voulez garder les données), l'application Access et les deux jetons de service dans Zero Trust, et le jeton d'API que Cloudflare a créé pour la construction à l'étape 10 (il reste valide une fois le Worker supprimé : **My Profile** › **API Tokens**, le jeton nommé d'après les constructions du Worker, **Delete**). Sur GitHub : **Settings** de votre copie › **Delete this repository**, puis **Settings** de votre compte › **Applications** › **Installed GitHub Apps** › **Cloudflare Workers and Pages** › **Configure** › **Uninstall**. Sur le Mac : supprimez le dossier `la-table` de votre dossier personnel, et les deux entrées du trousseau avec `security delete-generic-password -s la-table-access-client-id` et `security delete-generic-password -s la-table-access-client-secret`.
