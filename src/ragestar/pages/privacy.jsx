/* ==========================================================================
   privacy.jsx — the RageStar privacy policy, in the same visual language as
   the pricing and status pages.
   --------------------------------------------------------------------------
   This page is a legal document, not marketing. It says plainly what the
   gateway collects and, most importantly, that the requests and responses
   that pass through it are stored and used, including to train models. It is
   deliberately short, quiet and readable: no dark patterns, no all-caps walls.

   The two exported constants below are the single source of truth for the
   version that sign-in enforces. The sign-in form and the post-sign-in gate
   import them so a new policy is a one-line change here.
   ========================================================================== */

import { PageNav } from "./pages.jsx";
import { Badge, Reveal } from "../components/ui.jsx";

/* Bump PRIVACY_VERSION whenever the text below changes. Every account has to
   accept the current value again before it can use the dashboard. */
export const PRIVACY_VERSION = "2026-09-21";
export const PRIVACY_EFFECTIVE = "21 September 2026";

/* PLACEHOLDER CONTACT — confirm the real privacy mailbox before this page goes
   live. The sign-in form and the gate link here, so it must be reachable. */
const PRIVACY_CONTACT = "privacy@ragestar.bond";

/* One repeating section: a mono eyebrow, a display heading and body copy. */
function PolicySection({ eyebrow, title, children }) {
  return (
    <Reveal delay={60}>
      <section className="mt-12 border-t border-ink-700/40 pt-8">
        <span className="font-mono text-[10px] tracking-[0.18em] text-brand-ember uppercase">
          {eyebrow}
        </span>
        <h2 className="font-display mt-3 text-xl font-bold tracking-tight text-white/85 sm:text-2xl">
          {title}
        </h2>
        <div className="mt-4 max-w-3xl space-y-4 text-[14px] leading-relaxed text-white/65">
          {children}
        </div>
      </section>
    </Reveal>
  );
}

export default function PrivacyPage({ navigate, session }) {
  return (
    <div className="relative min-h-screen text-white/85">
      <div className="relative z-10">
        <PageNav navigate={navigate} session={session} />

        <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6 md:py-16">
          <Reveal>
            <Badge tone="ember">privacy</Badge>
          </Reveal>

          <Reveal delay={70}>
            <h1 className="font-display mt-5 max-w-2xl text-[2.4rem] leading-[1.02] font-bold tracking-[-0.03em] text-white/85 sm:text-5xl">
              Privacy Policy
            </h1>
          </Reveal>

          <Reveal delay={120}>
            <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-white/65">
              This policy explains what the RageStar gateway collects, how the content of your
              requests and responses is used, who it is shared with and how long it is kept.
            </p>
          </Reveal>

          <Reveal delay={150}>
            <p className="mt-6 font-mono text-[11px] tracking-[0.14em] text-white/65 uppercase">
              version {PRIVACY_VERSION} · effective {PRIVACY_EFFECTIVE}
            </p>
          </Reveal>

          <PolicySection eyebrow="scope" title="What this policy covers">
            <p>
              This policy covers the RageStar gateway API, the dashboard, the Playground, and the
              account you use to reach them. It applies whenever you send a request through any of
              those surfaces, whether from your own code or from a page in the product.
            </p>
            <p>
              It describes what we collect, what we do with it, who we share it with and how long we
              keep it. It is the whole of our promise about your data; nothing in an FAQ, a
              tooltip or a marketing page adds to or subtracts from it.
            </p>
          </PolicySection>

          <PolicySection eyebrow="collection" title="What we collect">
            <p>
              <span className="text-white/85">Account details.</span> The name, email address and
              organisation you give us when you create an account or update your profile.
            </p>
            <p>
              <span className="text-white/85">API key metadata.</span> The names, prefixes, scopes,
              limits and last-used times of the keys issued to your account. The secret value of a
              key is shown to you once and is not stored in a form we can read back.
            </p>
            <p>
              <span className="text-white/85">Request and usage logs.</span> The model that served a
              request, its timing, the token counts and cost, the status it returned, the IP address
              the request came from, and a timestamp.
            </p>
            <p>
              <span className="text-white/85">The content of your requests and responses.</span> What
              that is, and what happens to it, is the subject of the next section.
            </p>
            <p>
              We collect this information to run and secure the service, to meter usage, to fix
              problems, and to improve what we build.
            </p>
          </PolicySection>

          {/* The most important section on the page. It is stated as fact, not as
              a possibility, and it is kept short so it cannot be skimmed past. */}
          <Reveal delay={60}>
            <section className="mt-12 rounded-2xl border-[1.5px] border-brand-ember/40 bg-brand-ember/[0.07] p-6 sm:p-7">
              <span className="font-mono text-[10px] tracking-[0.18em] text-brand-ember uppercase">
                how your content is used
              </span>
              <h2 className="font-display mt-3 text-xl font-bold tracking-tight text-white/85 sm:text-2xl">
                How we use requests and responses
              </h2>
              <p className="mt-4 max-w-3xl text-[14px] leading-relaxed text-white/70">
                The prompts, messages, files and other inputs you send to the gateway (the requests),
                and the outputs the gateway returns to you (the responses), are stored, reviewed,
                processed and used by the company.
              </p>
              <p className="mt-4 max-w-3xl text-[14px] leading-relaxed text-white/70">
                This use includes operating, improving, developing, training and fine-tuning our
                services and models. It applies to every request, whether it comes from the API, the
                Playground, or anywhere else in the product.
              </p>
              <p className="mt-4 max-w-3xl text-[13.5px] leading-relaxed text-white/65">
                We do not sell your content, and we do not treat it as confidential. This is a
                material term of using the service, and it is why we ask you not to send anything you
                would not be willing to have stored and reviewed.
              </p>
            </section>
          </Reveal>

          <PolicySection eyebrow="confidentiality" title="No confidentiality in prompt or response content">
            <p>
              Because requests and responses are used as described above, they are not treated as
              confidential. Do not send secrets, credentials, API keys or passwords through the
              gateway, and do not send personal data about other people that you are not permitted to
              share.
            </p>
            <p>
              If you would not want a piece of text stored, reviewed, processed or used to improve
              our services and models, do not put it in a prompt, a message or a file. The same
              applies to anything you paste into the Playground.
            </p>
          </PolicySection>

          <PolicySection eyebrow="sharing" title="Sharing">
            <p>
              We share content with sub-processors, upstream model providers and infrastructure
              providers who process it on our behalf. They are bound by contract to use it only for
              the purposes described in this policy.
            </p>
            <p>
              We and these providers operate in more than one country, so your information may be
              transferred to, stored in and processed in a country other than the one you live in,
              which may have different data-protection laws.
            </p>
            <p>
              We may also disclose information where the law requires it, or where it is necessary to
              protect the service or its users.
            </p>
          </PolicySection>

          <PolicySection eyebrow="retention" title="Retention">
            <p>
              We keep content and logs for as long as we need them for the uses described in this
              policy. How long that is depends on the type of information, our legal obligations, and
              whether it is still useful for operating, securing and improving the service.
            </p>
            <p>
              We do not promise blanket deletion on a fixed schedule. If you want to know what we
              hold about your account, or ask us to remove it, use the contact in the next section.
            </p>
          </PolicySection>

          <PolicySection eyebrow="your choices" title="Your choices">
            <p>
              You can stop using the service at any time. You can delete your account, ask what we
              hold, or ask any question about this policy, by writing to{" "}
              <a
                href={`mailto:${PRIVACY_CONTACT}`}
                className="text-brand-ember underline decoration-brand-ember/40 underline-offset-4 hover:decoration-brand-ember"
              >
                {PRIVACY_CONTACT}
              </a>
              .
            </p>
            <p>
              Where the law gives you a right to access, correct, delete or object to the processing
              of your data, you can exercise it through that address. Deleting an account removes
              your profile and your keys; content that has already been used to operate or improve
              the service may remain in aggregated or model-derived form.
            </p>
          </PolicySection>

          <PolicySection eyebrow="changes" title="Changes">
            <p>
              We may change this policy. When we do, we publish a new version with a new version
              number and effective date at the top of this page.
            </p>
            <p>
              If the change is material, you must accept the new version before you can keep using
              the dashboard. The app will ask you to accept it the next time you sign in.
            </p>
          </PolicySection>

          <Reveal delay={60}>
            <div className="mt-12 flex flex-col items-start justify-between gap-4 border-t border-ink-700/40 pt-7 sm:flex-row sm:items-center">
              <p className="font-mono text-[10.5px] tracking-[0.16em] text-white/65 uppercase">
                version {PRIVACY_VERSION} · effective {PRIVACY_EFFECTIVE}
              </p>
              <button
                onClick={() => navigate("")}
                className="rounded-full border border-white/12 bg-white/5 px-4 py-2 font-mono text-[10.5px] tracking-[0.14em] text-white/65 uppercase hover:text-white"
              >
                ← Back to home
              </button>
            </div>
          </Reveal>
        </section>
      </div>
    </div>
  );
}
