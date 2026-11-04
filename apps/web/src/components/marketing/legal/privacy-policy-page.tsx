import { Link } from "@tanstack/react-router"
import { LegalDocument, type LegalSection } from "~/components/marketing/legal/legal-document"
import { LEGAL_BRAND, LEGAL_ENTITY, LEGAL_LOCATION } from "~/lib/marketing/legal"
import { CONTACT_EMAIL, CONTACT_URL } from "~/lib/marketing/links"

const Mail = () => <a href={CONTACT_URL}>{CONTACT_EMAIL}</a>

const SUBPROCESSORS: { name: string; purpose: string; location: string }[] = [
  {
    name: "Cloudflare, Inc.",
    purpose:
      "Hosting of the dashboard, API edge, docs sites and MCP server; storage of docs content and uploads; build containers that read your repository; email delivery; request logs",
    location: "United States and Cloudflare's global network",
  },
  {
    name: "Amazon Web Services, Inc.",
    purpose: "API servers, cache, secrets and operational monitoring",
    location: "United States",
  },
  {
    name: "PlanetScale, Inc.",
    purpose: "Primary database (accounts, projects, teams, usage records)",
    location: "United States",
  },
  {
    name: "Anthropic, PBC",
    purpose: "AI models that read repository content and write or edit documentation",
    location: "United States",
  },
  {
    name: "OpenRouter, Inc.",
    purpose:
      "Routing to other AI models for some features, including the AI chat on docs sites when a site owner turns it on",
    location: "United States",
  },
  {
    name: "GitHub, Inc.",
    purpose: "Sign-in with GitHub, the Doxa GitHub App, repository access and pull request checks",
    location: "United States",
  },
  {
    name: "Google LLC",
    purpose: "Sign-in with Google, and web fonts on Doxa pages and docs sites",
    location: "United States",
  },
]

const STORAGE: { name: string; where: string; purpose: string }[] = [
  {
    name: "Session cookies",
    where: "doxa.so",
    purpose: "Keep you signed in. Required for the dashboard to work.",
  },
  {
    name: "sidebar_state",
    where: "doxa.so dashboard",
    purpose: "Remembers if the sidebar is open. Expires after 7 days.",
  },
  {
    name: "doxa:* local storage",
    where: "doxa.so dashboard",
    purpose: "Remembers your last project, sidebar width, branch and open folders.",
  },
  {
    name: "Theme, search and chat history",
    where: "Docs sites",
    purpose: "Remembers light or dark mode, recent searches and AI chat history in the visitor's browser.",
  },
  {
    name: "API playground values",
    where: "Docs sites",
    purpose: "Keeps the values a visitor types into an API playground for the browser session. They stay in the browser.",
  },
]

const SECTIONS: LegalSection[] = [
  {
    id: "scope",
    title: "Who we are and what this covers",
    body: (
      <>
        <p>
          Doxa is operated by {LEGAL_ENTITY}, which does business as {LEGAL_BRAND} ("{LEGAL_BRAND}", "we", "us"). Our
          mailing address is {LEGAL_LOCATION}.
        </p>
        <p>This policy applies to the hosted Doxa service:</p>
        <ul>
          <li>the website and dashboard at doxa.so,</li>
          <li>the Doxa API and the Doxa GitHub App,</li>
          <li>the MCP server at mcp.doxa.so,</li>
          <li>docs sites that we host on doxa.page and on custom domains,</li>
          <li>the emails that we send about your account.</li>
        </ul>
        <p>
          It does not apply to copies of Doxa that you or someone else run on your own servers ("self-hosted"). The
          operator of a self-hosted copy is responsible for the data that it processes.
        </p>
      </>
    ),
  },
  {
    id: "collect",
    title: "Information we collect",
    body: (
      <>
        <h3>Account information</h3>
        <p>
          When you create an account, we collect your name, email address and profile picture. If you sign up with an
          email and password, we store a hash of your password, never the password itself. If you sign in with GitHub
          or Google, we receive your basic profile from that provider, which includes your GitHub username, and we
          store the tokens that the provider issues.
        </p>
        <h3>Repositories and content</h3>
        <p>
          When you install the Doxa GitHub App, GitHub gives us read access to the contents and pull requests of the
          repositories that you select. We store repository names and metadata. To generate docs, we read source code
          from those repositories. We also store the content that you create or that Doxa writes for you: docs pages,
          site settings, uploaded images, custom domain names and generation history. Pull request records include the
          GitHub username and avatar of the pull request author, who may not be a Doxa user.
        </p>
        <h3>Teams</h3>
        <p>
          We store team names, member roles, and the email addresses of people that you invite. Invitations expire
          after 7 days.
        </p>
        <h3>Connected agents</h3>
        <p>
          When you connect an AI agent through the MCP server, we store the name of the agent, the scopes and projects
          that you approved, its access tokens, and a record of the tools that it called. That record stores a hash of
          the tool input, not the content.
        </p>
        <h3>Usage and technical data</h3>
        <p>
          For each session, we store your IP address and browser user agent. Our hosting providers keep request logs,
          which contain IP addresses, URLs and timestamps. We record usage of the service, such as the AI tokens and
          cost of each generation and the page titles that it wrote. We use this data for limits, billing and
          support.
        </p>
        <h3>Email records</h3>
        <p>
          We keep a record of each email that we send to you, your notification preferences, and a list of addresses
          that bounced or unsubscribed.
        </p>
        <h3>Messages to us</h3>
        <p>If you write to us, we keep the message and our reply.</p>
        <h3>Payment information</h3>
        <p>
          Doxa does not take payments today. When paid plans start, a payment processor will collect your card
          details. We will update this policy before that happens.
        </p>
      </>
    ),
  },
  {
    id: "use",
    title: "How we use information",
    body: (
      <>
        <p>We use the information above to:</p>
        <ul>
          <li>create your account, sign you in and keep your session secure,</li>
          <li>read your repositories, generate and update documentation, and host your docs sites,</li>
          <li>run the actions that you or your connected agents request, and ask for approval when your policy requires it,</li>
          <li>send emails about your account, such as verification, password resets, invitations and notifications,</li>
          <li>enforce plan limits, measure cost, and bill you when paid plans exist,</li>
          <li>find and stop abuse, fraud and security incidents,</li>
          <li>fix problems, answer support requests and improve the service,</li>
          <li>obey the law and enforce our <Link to="/legal/terms">Terms of Service</Link>.</li>
        </ul>
        <p>
          We do not sell your personal information. We do not share it for targeted advertising. We do not use
          advertising or analytics trackers in the dashboard or on the docs sites that we host. We do not send
          marketing email unless you ask for it.
        </p>
      </>
    ),
  },
  {
    id: "ai",
    title: "AI processing of your code and content",
    body: (
      <>
        <p>
          Doxa uses AI models to read your code and to write and edit documentation. When a generation runs, we copy
          the selected repository into a temporary, isolated build container. We delete that copy when the job ends.
          The agent sends the parts of the code and docs that it needs to an AI model provider, which returns the
          text.
        </p>
        <ul>
          <li>
            Our main provider is Anthropic. Anthropic's commercial terms do not permit it to train its models on the
            content that we send.
          </li>
          <li>
            Some features use other models through OpenRouter. We use these only with providers and settings that do
            not train on the content that we send.
          </li>
          <li>We do not use your code or content to train AI models.</li>
        </ul>
        <p>
          We keep generation caches and diagnostics for up to 30 days. These help a later run reuse work and help us
          find failures.
        </p>
      </>
    ),
  },
  {
    id: "docs-sites",
    title: "Visitors to docs sites we host",
    body: (
      <>
        <p>
          Our customers publish docs sites on Doxa. The customer decides what the site contains. For the personal
          information of site visitors, we act as a service provider (a "processor") for that customer.
        </p>
        <ul>
          <li>Our hosting provider logs each request, with the IP address and user agent, for security and operations.</li>
          <li>The site stores the theme, recent searches and chat history in the visitor's browser.</li>
          <li>
            If the site owner turns on AI chat, we send the visitor's questions and the relevant docs content to an AI
            model provider to write the answer.
          </li>
          <li>The site loads fonts from Google Fonts, so Google receives the visitor's IP address.</li>
        </ul>
        <p>
          We do not put advertising or analytics trackers on hosted docs sites. If you visit a docs site and have a
          question about your data, contact the owner of that site first. You can also write to us at <Mail />.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and browser storage",
    body: (
      <>
        <p>
          We use only the cookies and browser storage that the service needs to work and to remember your settings. We
          do not use advertising or analytics cookies.
        </p>
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Where</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {STORAGE.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.where}</td>
                  <td>{row.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          You can clear cookies and browser storage in your browser settings. If you block session cookies, you cannot
          sign in.
        </p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "How we share information",
    body: (
      <>
        <p>We share personal information only in these cases:</p>
        <ul>
          <li>
            <strong>Service providers.</strong> The companies in the table below process data for us, under contracts
            that limit their use of it to the service that they provide.
          </li>
          <li>
            <strong>Your team.</strong> Members of a team can see the team's projects, members, invitations and
            activity.
          </li>
          <li>
            <strong>GitHub.</strong> When Doxa reports on a pull request, GitHub shows the result in your repository.
          </li>
          <li>
            <strong>The public.</strong> A published docs site is public. Anything that you publish on it is visible to
            anyone.
          </li>
          <li>
            <strong>Legal reasons.</strong> We disclose information when the law requires it, or to protect the rights,
            property or safety of our users, the public or us.
          </li>
          <li>
            <strong>Business transfers.</strong> If we are part of a merger, acquisition or sale of assets, your
            information can transfer to the new owner under this policy.
          </li>
          <li>
            <strong>With your consent.</strong> In other cases, we share information only when you tell us to.
          </li>
        </ul>
        <h3>Service providers</h3>
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Purpose</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.purpose}</td>
                  <td>{row.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>We update this list when we add or replace a provider.</p>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep information",
    body: (
      <>
        <p>We keep personal information while your account is active, and as long as we need it for the purposes above.</p>
        <ul>
          <li>The copy of your repository in a build container: deleted when the job ends.</li>
          <li>Generation caches and diagnostics: up to 30 days.</li>
          <li>Published versions of a docs site: the latest 20 versions, or 90 days of history.</li>
          <li>Pull request previews: 7 days.</li>
          <li>Team invitations: 7 days, unless accepted.</li>
          <li>Agent access tokens: 1 hour. Agent refresh tokens: 30 days, or 14 days without use.</li>
          <li>Usage records: as long as we need them for billing, accounting and tax.</li>
        </ul>
        <p>
          When you delete a project, we remove its domains and data and queue its stored files for deletion. When you
          ask us to delete your account, we delete your personal information within 30 days. We can keep some records
          longer when the law requires it, to settle disputes, or to enforce our agreements. Copies in backups and logs
          expire on their normal schedule.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <>
        <p>We protect your information with technical and organizational measures. For example:</p>
        <ul>
          <li>All traffic to Doxa uses HTTPS.</li>
          <li>GitHub access tokens are short-lived and limited to one repository per job.</li>
          <li>Build containers are temporary and isolated for each job.</li>
          <li>We store invitation tokens and agent tool inputs only as hashes.</li>
          <li>Access to production systems is limited to the people who operate the service.</li>
        </ul>
        <p>
          No system is perfectly secure. If a breach affects your personal information, we will tell you as the law
          requires. To report a security problem, write to <Mail />.
        </p>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your choices and rights",
    body: (
      <>
        <p>You can do these things yourself at any time:</p>
        <ul>
          <li>Edit your profile and docs content in the dashboard.</li>
          <li>Delete a project in its settings.</li>
          <li>Turn off notification emails in settings, or with the unsubscribe link in each email.</li>
          <li>Revoke a connected agent in Settings › Connected agents.</li>
          <li>Remove the Doxa GitHub App from your GitHub account or organization.</li>
        </ul>
        <p>
          Depending on where you live, you can also have the right to access, correct, export or delete your personal
          information, to object to or restrict some processing, and to withdraw consent. To make a request, including
          a request to delete your account, write to <Mail /> from the email address on your account. We will confirm
          your identity before we act, and we will answer within 30 days. We will not treat you differently because
          you used these rights.
        </p>
        <h3>European Economic Area, United Kingdom and Switzerland</h3>
        <p>We process your personal information on these legal bases:</p>
        <ul>
          <li>to perform our contract with you, when we provide the service,</li>
          <li>
            our legitimate interests, for security, abuse prevention and improvement of the service, when your rights
            do not override them,
          </li>
          <li>to obey legal obligations,</li>
          <li>your consent, when we ask for it.</li>
        </ul>
        <p>You can complain to your local data protection authority.</p>
        <h3>California</h3>
        <p>
          In the last 12 months, we collected the categories of information in{" "}
          <a href="#collect">Information we collect</a>: identifiers, account and team details, internet activity
          (logs and usage), and the content that you give us. We collected them for the purposes in{" "}
          <a href="#use">How we use information</a> and disclosed them only as described in{" "}
          <a href="#sharing">How we share information</a>. We do not sell or share personal information as the
          California Consumer Privacy Act defines those terms. We do not use sensitive personal information for any
          purpose that the law requires us to offer an opt-out for. You can use an authorized agent to make a request.
        </p>
      </>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    body: (
      <p>
        We are in the United States, and we and most of our providers process data there. If you use Doxa from
        another country, your information goes to the United States. Where the law requires it, we rely on
        safeguards such as the European Commission's Standard Contractual Clauses for these transfers.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        Doxa is a tool for developers and is not for children. You must be at least 16 years old to use it. We do not
        knowingly collect personal information from children under 16. If you think that a child gave us personal
        information, write to <Mail /> and we will delete it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        We will change this policy when the service or the law changes. We will update the "Last updated" date at the
        top. If a change is material, we will tell you by email or in the dashboard before it takes effect.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <>
        <p>For any question about this policy or your personal information, contact us:</p>
        <p className="doc__address">
          {LEGAL_ENTITY} ({LEGAL_BRAND})
          <br />
          {LEGAL_LOCATION}
          <br />
          <Mail />
        </p>
      </>
    ),
  },
]

export function PrivacyPolicyPage() {
  return (
    <LegalDocument
      doc="privacy"
      sections={SECTIONS}
      intro={
        <div className="doc__short">
          <span className="label">In short</span>
          <ul>
            <li>We collect what we need to run Doxa: your account, your repositories and the docs that you make.</li>
            <li>AI providers process your code only to write your docs. Nobody trains models on it.</li>
            <li>No ads, no analytics trackers, and we never sell your data.</li>
            <li>
              You can export or delete your data. Write to <Mail />.
            </li>
          </ul>
        </div>
      }
    />
  )
}
