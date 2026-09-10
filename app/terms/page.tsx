import type { Metadata } from "next";
import { LegalPage, H2, P, List, Item, Strong } from "../components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "Vaticr is non-custodial testnet software under Apache-2.0. Its forecasts are estimates that are wrong roughly a quarter of the time, and nothing here is financial advice.",
};

const GITHUB = "https://github.com/mrnetwork0001/Vaticr";

export default function Terms() {
  return (
    <LegalPage
      title="Terms of use"
      updated="7 September 2026"
      summary={
        <>
          Vaticr is <Strong>non-custodial testnet software</Strong> published
          under Apache-2.0 with no warranty. It never holds your keys or your
          funds, it publishes probabilities that are <Strong>wrong roughly a
          quarter of the time</Strong>, and nothing it produces is financial
          advice. Every transaction is yours: you sign it, and you own the
          outcome.
        </>
      }
    >
      <H2>1. What this is</H2>
      <P>
        Vaticr derives a probability for each DreamDEX Event Contract window,
        trades the gap between that probability and the order book, and commits
        each forecast onchain before the window settles so the record can be
        audited afterwards. It is an independent project. It is{" "}
        <Strong>not affiliated with, endorsed by, or operated by DreamDEX or
        Somnia</Strong>, whose protocols it builds on and does not control.
      </P>

      <H2>2. Testnet only</H2>
      <P>
        The app runs against Somnia&apos;s Shannon testnet. Test tokens{" "}
        <Strong>have no monetary value</Strong>, cannot be exchanged for
        anything, and may be reset or discarded by the network at any time. Do
        not send real assets to any address shown in this app, and do not treat
        a testnet balance as a holding.
      </P>

      <H2>3. Non-custodial, by construction</H2>
      <P>
        We never take custody of your funds and never receive your private key or
        seed phrase. Your wallet signs every transaction; approvals, orders and
        claims execute directly against the DreamDEX contracts. Consequently{" "}
        <Strong>we cannot reverse, cancel, refund or recover</Strong> anything you
        sign. If you lose access to your wallet, we cannot help you.
      </P>

      <H2>4. A forecast is an estimate, not a promise</H2>
      <P>
        This deserves plain language. Across the frozen backtest of 900 forecasts
        published with this project, the model was accurate on{" "}
        <Strong>76.22%</Strong> of them. That is a real edge over a coin flip, and
        it also means that roughly <Strong>one forecast in four was wrong</Strong>.
        A probability of 0.80 is a statement that the thing fails one time in five,
        and the fifth time is not a malfunction.
      </P>
      <P>
        Past measured performance does not predict future results. Nothing on this
        site or produced by the agent is financial, investment, legal or tax
        advice, or a solicitation to trade. You are responsible for your own
        decisions and for complying with the laws that apply to you - including
        any that restrict trading event contracts where you live.
      </P>

      <H2>5. Settlement is not ours</H2>
      <P>
        Windows settle automatically through the DreamDEX protocol&apos;s oracle,
        onchain, without our involvement. Vaticr&apos;s settlement audit{" "}
        <em>recomputes</em> outcomes from the public feed and compares them to the
        chain; it observes and cannot alter them. If a settlement is disputed, that
        is a matter for the protocol, not for us.
      </P>

      <H2>6. The agent trades its own inventory</H2>
      <P>
        When run, the trading loop places orders from the key it is configured
        with. It is not a managed service, it does not trade on your behalf, and
        it accepts no deposits. If you run it yourself, you run it{" "}
        <Strong>at your own risk and with your own key</Strong>. Read{" "}
        <a href={`${GITHUB}/blob/main/README.md`} className="text-model hover:underline" target="_blank" rel="noreferrer">
          the README
        </a>{" "}
        first; it starts in dry-run mode for a reason.
      </P>

      <H2>7. Acceptable use</H2>
      <List>
        <Item>Do not use the app to break the law that applies to you.</Item>
        <Item>
          Do not attempt to manipulate market prices, spam the order book, or
          disrupt the service or the underlying protocol for others.
        </Item>
        <Item>
          Do not present the agent&apos;s output as a guarantee, or resell it as
          advice, to anyone.
        </Item>
      </List>

      <H2>8. No warranty</H2>
      <P>
        The software is licensed under Apache-2.0 and provided{" "}
        <Strong>&ldquo;AS IS&rdquo;, without warranties or conditions of any kind</Strong>,
        express or implied. To the fullest extent permitted by law, we are not
        liable for any loss arising from use of the app or the agent - including
        losing a trade, a failed or stuck transaction, an unavailable RPC or
        indexer, a wrong forecast, or a bug in this code. The full terms are in the{" "}
        <a href={`${GITHUB}/blob/main/LICENSE`} className="text-model hover:underline" target="_blank" rel="noreferrer">
          LICENSE
        </a>
        , and where this page and that licence disagree, the licence governs.
      </P>

      <H2>9. Availability</H2>
      <P>
        There is no uptime commitment. The app depends on services we do not run -
        a testnet, an RPC endpoint, an indexer and public news feeds - any of which
        can be slow, stale or unavailable, and the app will say so rather than
        invent a number to fill the gap.
      </P>

      <H2>10. Changes</H2>
      <P>
        These terms may change; the date at the top says when they last did, and
        the repository history shows exactly what changed. Continuing to use the
        app after a change means you accept it.
      </P>
    </LegalPage>
  );
}
