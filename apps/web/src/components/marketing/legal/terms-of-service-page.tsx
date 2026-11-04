import { Link } from "@tanstack/react-router"
import { LegalDocument, type LegalSection } from "~/components/marketing/legal/legal-document"
import { LEGAL_BRAND, LEGAL_ENTITY, LEGAL_LOCATION } from "~/lib/marketing/legal"
import { CONTACT_EMAIL, CONTACT_URL } from "~/lib/marketing/links"

const Mail = () => <a href={CONTACT_URL}>{CONTACT_EMAIL}</a>
const Privacy = () => <Link to="/legal/privacy">Privacy Policy</Link>

const SECTIONS: LegalSection[] = [
  {
    id: "agreement",
    title: "The agreement",
    body: (
      <>
        <p>
          These Terms of Service ("Terms") are an agreement between you and {LEGAL_ENTITY}, which does business as{" "}
          {LEGAL_BRAND} ("{LEGAL_BRAND}", "we", "us"). They apply when you use the hosted Doxa service.
        </p>
        <p>
          You accept these Terms when you create an account or use the service. If you do not accept them, do not use
          Doxa. If you use Doxa for a company or other organization, you accept these Terms for that organization, and
          you confirm that you have the authority to do so. In that case, "you" means the organization.
        </p>
        <p>
          Our <Privacy /> explains how we handle personal information. It is part of these Terms.
        </p>
      </>
    ),
  },
  {
    id: "service",
    title: "The service",
    body: (
      <>
        <p>
          Doxa generates documentation from your code, keeps it up to date, and hosts it as a docs site. The service
          ("Service") includes the website and dashboard at doxa.so, the Doxa API, the Doxa agent, the Doxa GitHub App,
          the MCP server, and the docs sites that we host.
        </p>
        <p>
          We improve Doxa all the time, so features change. We can add, change or remove features. If we remove a
          feature that you depend on, we will try to give you notice first.
        </p>
        <p>
          The Doxa source code can also be available under an open-source license. That license, not these Terms,
          controls your use of the source code. These Terms control your use of the Service that we host.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts",
    body: (
      <>
        <ul>
          <li>You must be at least 16 years old, and old enough to make a binding contract where you live.</li>
          <li>Give us accurate information, and keep your email address up to date.</li>
          <li>
            Keep your password, sessions and agent tokens secure. You are responsible for everything that happens under
            your account.
          </li>
          <li>Tell us at once at <Mail /> if you think that someone used your account without permission.</li>
          <li>One person or one automated agent that you authorize can use each account. Do not share accounts.</li>
        </ul>
        <p>
          A team owner controls the team's projects and members. If you join a team, the owner can see your activity
          in the team and can remove you.
        </p>
      </>
    ),
  },
  {
    id: "your-content",
    title: "Your content",
    body: (
      <>
        <p>
          "Your Content" is everything that you or your team give to the Service or create with it: source code that
          we read from your repositories, docs pages, site settings, images and other files, and the output that Doxa
          generates for you.
        </p>
        <p>
          You own Your Content. We claim no ownership of it. You give us a worldwide, non-exclusive, royalty-free
          license to host, copy, store, process, transmit, display and change the format of Your Content, only as
          necessary to provide, secure and support the Service. This includes sending it to our AI model providers to
          generate docs, as described in the <Privacy />. The license ends when Your Content is deleted from the
          Service, except for copies that we must keep by law and copies in backups that expire on their normal
          schedule.
        </p>
        <p>
          We do not use Your Content to train AI models. We do not look at your private content unless you ask us to,
          to keep the Service secure, or when the law requires it.
        </p>
        <p>
          You promise that you have the rights that you need to give us Your Content and this license, and that Your
          Content and its use with the Service do not break any law or any other person's rights.
        </p>
        <p>
          When you publish a docs site, its content is public. You decide what to publish and you are responsible for
          it.
        </p>
      </>
    ),
  },
  {
    id: "ai-output",
    title: "AI-generated output",
    body: (
      <>
        <p>
          Doxa uses AI models to write and edit documentation. As between you and us, you own the output that the
          Service generates for you, and it is part of Your Content.
        </p>
        <ul>
          <li>
            AI output can be wrong, incomplete or out of date, even when it reads well. Review it before you publish it
            or rely on it.
          </li>
          <li>Other users can receive output that is similar to yours. You have no exclusive right to it.</li>
          <li>You are responsible for the docs that you publish, including docs that an agent changed for you.</li>
        </ul>
      </>
    ),
  },
  {
    id: "github",
    title: "GitHub and other services",
    body: (
      <>
        <p>
          Doxa connects to services that other companies run, such as GitHub, Google and the AI agents that you
          connect. Their own terms control your use of them. We are not responsible for them.
        </p>
        <p>
          When you install the Doxa GitHub App, you give it the permissions that GitHub shows during installation, for
          the repositories that you select. You can change the selected repositories or remove the app at any time in
          GitHub.
        </p>
      </>
    ),
  },
  {
    id: "agents",
    title: "Connected agents",
    body: (
      <>
        <p>
          You can connect AI agents, such as coding assistants, to Doxa through the MCP server. When you approve an
          agent, you let it act for you, within the scopes and projects that you select.
        </p>
        <ul>
          <li>Actions that a connected agent takes with your approval are your actions under these Terms.</li>
          <li>
            Some actions, such as publishing, can need a human approval in the dashboard. That depends on the approval
            policy of the project.
          </li>
          <li>You can revoke an agent at any time in Settings › Connected agents.</li>
        </ul>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>Do not use the Service to, or try to:</p>
        <ul>
          <li>break any law, or help someone else break one,</li>
          <li>publish content that infringes another person's intellectual property, privacy or other rights,</li>
          <li>
            host malware, phishing pages, spam, or content that is sexually exploitative, harasses others, or
            encourages violence,
          </li>
          <li>use a docs site for something other than documentation, such as general file hosting or mirroring,</li>
          <li>
            get access to another customer's data, or to any account, system or repository that you have no permission
            to use,
          </li>
          <li>
            test, scan or break the security of the Service, unless we agreed in writing. Report security problems to{" "}
            <Mail />,
          </li>
          <li>
            get around plan limits, rate limits or other technical limits, for example with many free accounts,
          </li>
          <li>overload or disrupt the Service, or send traffic that is not from real use,</li>
          <li>
            use prompts or content to make the Doxa agent act against its instructions, or to extract data that is not
            yours,
          </li>
          <li>connect a custom domain that you do not control,</li>
          <li>pretend to be another person or organization, or suggest that we endorse you,</li>
          <li>resell the Service without our written permission.</li>
        </ul>
        <p>
          We can remove content or limit an account that breaks this section. When we can, we will tell you why and
          give you a chance to fix the problem.
        </p>
      </>
    ),
  },
  {
    id: "copyright",
    title: "Copyright complaints",
    body: (
      <p>
        If you think that a docs site that we host infringes your copyright, send a notice to <Mail />. Include the URL
        of the content, the work that you think was copied, your contact details, and a statement, under penalty of
        perjury, that the information is accurate and that you are the owner or are authorized to act for the owner.
        We will remove content when the law requires it, and we will close the accounts of repeat infringers.
      </p>
    ),
  },
  {
    id: "plans",
    title: "Plans, fees and limits",
    body: (
      <>
        <p>
          The Free plan is available at no cost, with the limits shown on our <Link to="/pricing">pricing page</Link>{" "}
          and in the dashboard. We can change the limits of the Free plan.
        </p>
        <p>When paid plans are available, these rules apply to them:</p>
        <ul>
          <li>The price and limits are the ones shown when you subscribe.</li>
          <li>Fees are charged in advance for each billing period and renew until you cancel.</li>
          <li>You can cancel at any time. The plan stays active until the end of the period that you paid for.</li>
          <li>Fees are not refundable, except where the law requires a refund or we agree to one.</li>
          <li>Prices do not include taxes. You pay the taxes that apply, other than taxes on our income.</li>
          <li>We will tell you at least 30 days before a price change takes effect for your plan.</li>
        </ul>
      </>
    ),
  },
  {
    id: "ours",
    title: "Our rights",
    body: (
      <>
        <p>
          We and our licensors own the Service, including its software, design and the Doxa name and logos, except Your
          Content and the open-source code that is licensed to you. These Terms do not give you the right to use our
          names, logos or trademarks.
        </p>
        <p>
          If you send us feedback or ideas, we can use them without any obligation to you.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and termination",
    body: (
      <>
        <p>
          You can stop using Doxa at any time. To close your account, write to <Mail />.
        </p>
        <p>We can suspend or close your account, or a docs site, if:</p>
        <ul>
          <li>you break these Terms,</li>
          <li>we must do so to protect the Service, our users or the public,</li>
          <li>the law requires it, or</li>
          <li>we stop the Service, in which case we will give you at least 30 days' notice.</li>
        </ul>
        <p>
          When we can, we will tell you before we act and give you time to export Your Content. After your account
          closes, we delete Your Content as described in the <Privacy />. The sections about your content license,
          our rights, disclaimers, liability, indemnity and disputes stay in effect after these Terms end.
        </p>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <p className="doc__caps">
        The Service is provided "as is" and "as available". To the maximum extent that the law permits, we disclaim
        all warranties, express or implied, including warranties of merchantability, fitness for a particular purpose,
        title and non-infringement. We do not promise that the Service will be uninterrupted, secure or free of errors,
        that AI output will be accurate, or that content will never be lost. Keep your own copies of important content.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <>
        <p className="doc__caps">
          To the maximum extent that the law permits, {LEGAL_ENTITY} and its members, employees and suppliers are not
          liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of profits,
          revenue, data or goodwill, that come from or relate to the Service or these Terms, even if we knew that they
          were possible.
        </p>
        <p className="doc__caps">
          Our total liability for all claims that come from or relate to the Service or these Terms is limited to the
          greater of (a) the amounts that you paid us for the Service in the 12 months before the claim, and (b) one
          hundred US dollars (US$100).
        </p>
        <p>
          Some places do not allow these exclusions or limits. In those places, they apply only as far as the law
          permits.
        </p>
      </>
    ),
  },
  {
    id: "indemnity",
    title: "Indemnity",
    body: (
      <p>
        If a third party makes a claim against us because of Your Content, or because you or your connected agents
        broke these Terms or the law, you will defend us and pay the costs, damages and reasonable legal fees that come
        from that claim. We will tell you about the claim promptly and let you control the defense, but we can take
        part with our own lawyers at our own cost.
      </p>
    ),
  },
  {
    id: "disputes",
    title: "Governing law and disputes",
    body: (
      <>
        <p>
          The laws of the State of California and of the United States control these Terms, without regard to
          conflict of law rules.
        </p>
        <p>
          Before you start a legal claim, write to <Mail /> and let us try to solve the problem. If we cannot solve it
          within 30 days, either of us can take it to the state courts of Contra Costa County, California, or the
          federal courts of the Northern District of California. You and we agree to the jurisdiction of those courts.
          Either of us can ask any court for urgent relief to protect intellectual property or confidential
          information.
        </p>
        <p>If you are a consumer, the mandatory consumer protection laws of the country where you live still apply.</p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: (
      <p>
        We can change these Terms. We will update the "Last updated" date at the top. If a change is material, we will
        tell you by email or in the dashboard at least 30 days before it takes effect, unless the law or a security
        risk requires a faster change. If you continue to use the Service after a change takes effect, you accept the
        new Terms. If you do not accept them, stop using the Service and close your account.
      </p>
    ),
  },
  {
    id: "general",
    title: "General",
    body: (
      <ul>
        <li>
          These Terms and the <Privacy /> are the full agreement between you and us about the Service. A separate
          written agreement that we both sign takes priority over them.
        </li>
        <li>
          You cannot transfer these Terms without our written consent. We can transfer them as part of a merger,
          acquisition or sale of assets.
        </li>
        <li>If a court finds part of these Terms invalid, the rest stays in effect.</li>
        <li>If we do not enforce a part of these Terms, we do not waive our right to enforce it later.</li>
        <li>
          We are not responsible for delays or failures that are caused by events outside our reasonable control.
        </li>
        <li>You must obey the export control and sanctions laws that apply to your use of the Service.</li>
        <li>We send notices to the email address on your account. Send notices to us at the address below.</li>
      </ul>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p className="doc__address">
        {LEGAL_ENTITY} ({LEGAL_BRAND})
        <br />
        {LEGAL_LOCATION}
        <br />
        <Mail />
      </p>
    ),
  },
]

export function TermsOfServicePage() {
  return (
    <LegalDocument
      doc="terms"
      sections={SECTIONS}
      intro={
        <div className="doc__short">
          <span className="label">In short</span>
          <ul>
            <li>You own your code, your docs and the output that Doxa writes for you.</li>
            <li>We use your content only to run the service. We do not train AI models on it.</li>
            <li>AI output can be wrong. Review it before you publish.</li>
            <li>Use Doxa for documentation, legally, and without harm to others or to the service.</li>
          </ul>
        </div>
      }
    />
  )
}
