# Bug Rally

A Jira front-end that shows progress as a race. It is not a game you play: it is your Jira board, drawn as race tracks.

- **Project = Circuit.** The start screen lists your Jira projects.
- **Team = Jira board.** Inside a project you pick your team: every Jira board of the project is a team page. It shows the issues in the board's filter, and its Kanban uses the board's columns. Per team, Bug Rally fills in the team's work group, components and labels on everything the team creates. There is also a *Whole project* view with no filter.
- **Feature (Epic) = Stage.** Each team page shows its stages with a progress bar. Unfinished stages come first, in Jira **Rank** order (top = highest); stages whose feature is marked done move to a **Finished stages** section, newest first, which you can collapse (Bug Rally remembers that per team page).
- **On a stage** every issue under the epic sits on the track, in Jira **Rank** order (finished ones first on the track, last in the lists below it):
  - **Tasks** are red fuel cans, **stories** are blue ones. Mark one done and it becomes a green checkpoint flag.
  - **Bugs** (Bug, Defect or **Fault Report** issue types) are traffic cones blocking the road. Mark one done and it gets knocked over.
  - The car drives up to the next open item, so how far it has come is your progress.
  - When everything is done the finish line waves and the trophy lights up. Mark the feature done to take it.
- **Not in any feature:** every team page has a *Free practice* stage with the tasks, stories and fault reports/bugs that don't belong to any feature (within the team's filter). Each row has a **Move to feature…** menu to sort them into a stage.
- **Due dates:** anything unfinished with a Jira due date 7 days away or less gets a ⏰ warning: yellow for *Due in 3–7 days*, orange for *Due today / tomorrow / in 2 days*, red for *Overdue*. You see it on Kanban cards, stage rows, the details panel, and for features on their stage card and in the Kanban rail. Features and the Kanban also sum it up, for example *1 overdue, 2 due within a week*.
- **Click any fuel can, cone or row** (or a feature's ID on the Kanban) to open its details: description, status, priority, people, dates, labels, attachments and comments, loaded live from Jira.
  - **Child items:** a feature's tasks, stories and bugs, or a ticket's sub-tasks, in rank order with their status.
  - **Related tickets:** the issue's Jira links, grouped by type (blocks, is blocked by, relates to…).
  - Click a child or related ticket to open its details; **←** goes back.

In the details you can:

- **See attachments.** Images show as thumbnails and open in a viewer; other files download.
- **Upload files** by dragging them onto the panel (or "choose files"). They go straight to the issue in Jira. Drop a file into the description or comment editor to attach it and link it in the text.
- **Edit the description** and **add comments**. Text uses Jira's formatting (`*bold*`, `_italic_`, `h3. Heading`, `* bullets`, `# numbers`, `[text|https://…]`), with a small toolbar. Formatting, tables and images in existing descriptions are kept.

You can also create projects, features (epics), tasks, stories and bugs, mark anything done and reopen it. Every change goes straight to Jira.

### Kanban view

Every team page has two views: **🏁 Stages** (the race track per feature) and **🚦 Kanban**.

- Kanban uses the full window width and shows all unfinished tasks, stories and fault reports/bugs in the team's filter, whether or not they are in a feature (minus those in hidden features). Issues in a linked feature that don't match the filter stay off the board, but they still count in that feature's progress.
- **Columns:** a board's team page always uses that board's columns (change them on the board in Jira). The *Whole project* view has a picker instead (remembered per project):
  - *Like Jira board: …* uses the column setup of one of the project's Jira boards, so many statuses are grouped exactly as on that board (for example To Do / In Progress / Verification). Cards in a grouped column show their exact status.
  - Columns can also hold Done statuses (Done, Closed…): they show what was finished in the last 14 days, and dropping a card there finishes it. Without such a column there's a separate **Done** drop zone.
  - *My own columns…* (or **✎ Edit columns**): name your columns (for example To Do / In Progress / Verification) and choose which Jira status goes in which column, e.g. *In Progress 3* → Verification. Works without access to Jira boards.
  - *To Do / In Progress* groups statuses by Jira's status category (the default).
  - *One column per status*.
  - Done statuses never get a column; use the **Done** drop zone.
- **Features rail** on the left: the team's unfinished features in Rank order, with their progress bar, done counts and how many of their cards are on the board. **Drag a feature** up or down (or Alt+↑ / Alt+↓) to change its rank in Jira; the Stages view follows the same order. **Drop a card on a feature** to move the issue into it (sets its parent), or on *Not in any feature* to take it out. Click a feature's **ID** (for example ARTZEE-1234) to open its details (description, comments, attachments), just like a card; from the keyboard, Shift+Enter. Click a feature to highlight its cards and fade the rest; click it again or **Show all cards** to clear. *Not in any feature* highlights the loose tasks and bugs, and 🏁 opens the feature's stage.
- Cards are sorted by Jira **Rank**, top = highest.
- **Drag a card above another** to rank it there (Jira's rank "before" that issue). Drop it at the bottom of a column to rank it after the last card.
- **Drag to another column** to change the status. For a column with several statuses, Bug Rally moves the issue to the first status in that column the workflow allows (like a Jira board does). If none is allowed, you get a message and the card snaps back.
- **Drop on Done** to finish the issue.
- Keyboard: focus a card, then **Alt+↑ / Alt+↓** moves it up or down one place.
- Ranking uses Jira Software's rank API, so it needs the *Schedule issues* permission in the project.

### Connecting existing work

- **Existing tasks and bugs → a stage:** in a stage, press **🔗 Link existing** and search Jira. Or open an issue and pick another feature under *Stage (feature)*. Both set the issue's parent in Jira.
- **Existing features → a team page:** on a team page, press **🔗 Link existing feature**, or open **⚙ Team settings**. You can link epics from other projects and hide epics you don't want as stages. A linked feature always shows all of its issues and full progress, even ones outside the team's filter. This is saved in Bug Rally only (`data/settings.json`) and doesn't change Jira.

### Off-board work

Finds unfinished work that boards miss, often tickets with a missing or wrong label, component or team:

- **On each board's page (Stages, and a 👥 button on the Kanban):** *Our people's other tickets* lists tickets in the project assigned to this board's people that this board doesn't show. A board's people are worked out automatically: the assignees of its not-started tickets (Jira status category *To Do*).
- **On the project page:** *Not on any board* lists everything in the project that none of the shown boards include. Boards whose filter is just the whole project (`project = KEY`) don't count here, since nothing would ever be outside them; the tile says which ones were left out.

Each one shows a count and opens like a team page, with Stages and Kanban, so you can move tickets into features or fix them in the details panel. Counts are kept for 5 minutes, and refreshed right away when you hide or show a board.

### Team pages

Every Jira board of the project is a team page, automatically: the boards that live in the project, like Jira's own board list. Boards of other projects and personal boards (which Jira's API also returns when their filter includes the project) start out hidden. Boards Jira still lists but that can't be opened (deleted boards, boards without a filter or whose filter is gone or not shared with you) are left out. Hover a board card and press **Hide** to hide one you don't use; it moves to *Hidden boards* at the bottom of the project page, where **Show** brings it back. Hiding only changes Bug Rally. Open **⚙ Team settings** on one to set:

- **Also filter the tasks and bugs inside each feature:** on by default. Untick it to show every issue in the team's features, even ones not on the board.
- **Issue type for bugs:** what **+ Bug** creates. *Automatic* uses **Fault Report** when the project has it, otherwise Bug. The button and lists use that name.
- **Defaults for new issues:** labels, components and a work-group field (for example Jira's *Team* field or a custom *Work group* select field) set automatically on everything the team creates from its page. Optionally also added when you link existing issues into a feature.
  - A default is skipped (and you get a message) when that field isn't on the create screen for that issue type. Components are only set on issues in the team page's own project.
  - For a Team field, enter the team ID (the last part of the team's URL in Jira).
- **Linked and hidden features** (see above).

The team name, which issues belong to the team, and the Kanban columns come from the board; change those in Jira. Listing boards needs the Jira Software permissions (see below). Team settings are saved in `data/settings.json`. Team pages made by hand in earlier versions of Bug Rally are no longer shown. In demo mode there are two sample boards and every board shows the whole project.

## Run it

Needs Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000.

Without a Jira connection it runs in **demo mode** with local sample data (in `data/`; delete `data/demo-data.json` to reset).

## Connect to Jira Cloud

Open **⚙ Settings** (top right). There are two ways to log in.

### Option 1: Each person signs in with their own Atlassian account (recommended)

Bug Rally is just another front end for Jira. Jira stays the backend: every person signs in with their own Atlassian account, the same way they log in to Jira (including company single sign-on). They see only what they can see in Jira, and everything they change is saved in Jira as them. The top bar shows who is signed in, with a **Sign out** button.

A web page can't borrow your existing Jira browser login directly (Atlassian blocks that for security), so this uses Atlassian's official OAuth 2.0 (3LO) sign-in. Whoever runs Bug Rally does a one-time setup that registers Bug Rally itself with Atlassian. The Client ID and secret are **not a user account**: nobody logs in with them and they can't see anything in Jira on their own. They just let Bug Rally show the Atlassian sign-in page. Even though the app is registered under the account of whoever set it up, nothing is done in Jira as that person: every request uses the access of the person who is signed in, appears in Jira's history as them and is limited to their permissions. The owner is only shown on the consent screen and can rotate the secret or delete the app.

1. Open the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and create an **OAuth 2.0 integration**.
2. **Permissions** → add **Jira API** → add the scopes `read:jira-work`, `write:jira-work` and `read:jira-user`.
   For the Kanban's Jira boards and drag-to-rank, also add these granular scopes (Jira Software doesn't accept the classic ones): `read:board-scope:jira-software`, `read:board-scope.admin:jira-software`, `write:issue:jira-software` and `read:project:jira`. Then tick *Ask for Jira Software permissions* on the Settings page and everyone signs in once more.
3. **Authorization** → set the callback URL to `http://localhost:3000/auth/callback` (the Settings page shows the exact URL to copy).
4. **Settings** → copy the Client ID and Secret into Bug Rally's Settings page, choose *Sign in with Atlassian*, enter your Jira address (for example `https://yourpage.atlassian.net`) and press **Save**.
5. Press **Sign in with Atlassian**.

Notes:

- A new app only works for the person who created it. To let colleagues sign in, turn on sharing under **Distribution** in the developer console.
- Large organisations often control which third-party apps may connect to their Jira. If the consent screen refuses, ask your Jira/Atlassian admins to allow the app.
- Creating new Jira projects from Bug Rally isn't covered by these scopes (and usually needs admin rights anyway).
- If Jira refuses one kind of request (for example boards, without the Jira Software scopes), Bug Rally shows why and keeps you signed in.
- A slow or briefly unavailable Atlassian service doesn't sign anyone out: Bug Rally retries, and only signs you out if Atlassian actually rejects the sign-in. Jira gets up to a minute per request.
- If *Like Jira board* isn't offered in the Kanban column picker, Jira didn't allow listing boards for your sign-in; use *My own columns* instead.
- Each person's sign-in is remembered in their own browser for up to 90 days of inactivity (the server keeps the matching tokens in `data/sessions.json`). **Sign out** in the top bar ends it.

### Option 2: One shared account (API token)

Everyone using this Bug Rally acts as the same Jira user. Handy for trying it out alone.

1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens (some companies turn API tokens off; then use option 1).
2. In Settings choose *API token*, enter your Jira address, email and the token, press **Test connection**, then **Save & connect**.

Prefer a config file? Copy `.env.example` to `.env` and fill in `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. Values saved on the Settings page win over `.env`.

### Where secrets live

Tokens and client secrets are stored in `data/` on the computer running Bug Rally (git-ignored) and are never sent to the browser. The browser only talks to the local server, which also fetches attachments so they display without a separate Jira login. The server only accepts connections from this computer. To share it on your network, set `HOST=0.0.0.0` and `PUBLIC_URL=http://your-computer:3000` in `.env`, and register that callback URL in the developer console. The Settings page can still only be changed from the computer itself.

### How things map to Jira

| In the app | In Jira |
| --- | --- |
| Mark done | Runs the first workflow transition that leads to a status in the **Done** category |
| Reopen | Runs a transition back to a **To Do** (or else **In Progress**) status |
| New feature | Creates an **Epic** |
| New task / story / bug | Creates that issue type with the epic as its **parent**. If the project has no Story type, a Task is created instead |
| Link existing / move to feature | Sets the issue's **parent** to that epic (or clears it for "No feature") |
| Upload | Adds an **attachment** to the issue |
| Edit description / comment | Saves Jira wiki markup through the REST API; Jira shows it as normal rich text |
| New project | Creates a company-managed Kanban software project with you as lead (API token only; needs Jira admin rights) |

Limits: epics load 200 at a time per team page: unfinished ones first (by Rank), then the most recently finished; press **Load 200 more features** to load the next 200, as often as needed; the *Not in any feature* stage shows up to 300 issues: all open ones plus those finished in the last 14 days. Sub-tasks don't appear on the track; you see them in their parent issue's details. Uploads are limited to 50 MB per file (`MAX_UPLOAD_MB` in `.env`).

## Project layout

```
server.js          Express server, REST API (/api/...) and Atlassian sign-in (/auth/...)
lib/jira.js        Jira Cloud REST client
lib/oauth.js       Sign in with Atlassian: sessions and token refresh
lib/demo.js        Local demo backend with the same interface
lib/board.js       Shared helpers (issue types, grouping)
lib/settings.js    Saved connection settings and team pages (data/settings.json)
public/            The web app: index.html, app.js, sprites.js, styles.css
```

All sprites are original pixel art drawn in code (`public/sprites.js`). Palette: Sweetie 16 by GrafxKid.
