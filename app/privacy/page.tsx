import type { Metadata } from "next";
import { LegalPage, H2, P, List, Item, Strong } from "../components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "Vaticr has no accounts, no cookies and no analytics. This page says exactly what your browser stores, what the server sees, and what is public on-chain by design.",
};

const GITHUB = "https://github.com/mrnetwork0001/Vaticr";

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy"
      updated="7 September 2026"
      summary={
        <>
          Vaticr has <Strong>no accounts, no sign-up, no cookies and no
          analytics</Strong>. We do not know who you are and have not built
          anything that could find out. What follows is not a disclaimer - it is
          a list of every place your data could go, written so you can check it
          against the source.
        </>
      }
    >
      <H2>What we do not collect</H2>
      <P>
        There is no registration, so there is no name, email address, password or
        profile. There is no analytics script, no tag manager, no session
        recorder and no advertising pixel on any page - you can confirm this by
        opening the network tab, or by reading{" "}
        <a href={`${GITHUB}/blob/main/app/layout.tsx`} className="text-model hover:underline" target="_blank" rel="noreferrer">
          app/layout.tsx
        </a>
        , which is the only place such a script could be injected.
      </P>
      <P>
        We set no cookies. Nothing on this site asks for a cookie banner because
        there is nothing to consent to.
      </P>

      <H2>What your browser stores</H2>
      <P>Two things, both local to your device, neither readable by us:</P>
      <List>
        <Item>
          <Strong>One preference.</Strong> The key <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[13px] text-gray-200">vaticr:rail-collapsed</code>{" "}
          remembers whether you collapsed the sidebar. Clearing site data resets
          it and nothing else.
        </Item>
        <Item>
          <Strong>Your wallet&apos;s own state.</Strong> If you connect a wallet,
          the connection library (wagmi) and, where you use it, WalletConnect
          store their session in your browser so a refresh does not disconnect
          you. That storage belongs to those tools and to your wallet, and is
          governed by their policies, not this one.
        </Item>
      </List>

      <H2>What the server sees</H2>
      <P>
        The web app and the forecasting service keep ordinary request logs -
        IP address, timestamp, path, user agent - the same records any web server
        writes, retained by the host for operational and security purposes. They
        are not joined to a wallet address, not used to build a profile, and not
        shared.
      </P>
      <P>
        The forecasting service stores <Strong>forecasts, not people</Strong>. Its
        records are market identifiers, probabilities, volatility estimates and
        settlement outcomes. No field in that store identifies a user, because no
        user is ever passed to it.
      </P>

      <H2>What is public on-chain, and permanently</H2>
      <P>
        This is the part worth reading twice. Anything you do <em>through</em> Vaticr
        that touches Somnia is a public blockchain transaction: your wallet
        address, the orders you place, the positions you hold and the winnings
        you claim. So is every forecast the agent commits to its registry
        contract - that permanence is the point of committing them.
      </P>
      <P>
        We do not publish this data; the chain does. <Strong>Neither we nor anyone
        else can delete or amend it</Strong>, which is a property of the network
        rather than a choice we made. Assume that anything you sign is public
        forever, and connect a wallet whose history you are comfortable with.
      </P>

      <H2>Third parties</H2>
      <P>Using the app causes requests to services we do not operate:</P>
      <List>
        <Item>
          <Strong>A Somnia RPC endpoint</Strong>, to read chain state and submit
          the transactions you sign. It sees your IP address and your requests.
        </Item>
        <Item>
          <Strong>The DreamDEX indexer</Strong>, for market and order-book data.
        </Item>
        <Item>
          <Strong>Your wallet</Strong>, which has its own policy and its own
          telemetry. We never receive your private key or seed phrase, and there
          is no code path in this project that could ask for one.
        </Item>
        <Item>
          <Strong>Public news feeds</Strong> (RSS, and CryptoPanic where an API
          key is configured) - requested by the server on a schedule, never by
          your browser, and with nothing about you attached.
        </Item>
      </List>

      <H2>What we never do</H2>
      <P>
        We do not sell data, share it with advertisers, or profile users. There is
        no mechanism in the codebase to do any of these things, and the codebase
        is the authority on this page.
      </P>

      <H2>This is testnet software</H2>
      <P>
        Vaticr runs on Somnia&apos;s Shannon testnet and was built for a
        hackathon. It is a working system, not a hosted commercial service with
        an operations team behind it. Treat it accordingly.
      </P>

      <H2>Questions</H2>
      <P>
        Raise an issue on{" "}
        <a href={GITHUB} className="text-model hover:underline" target="_blank" rel="noreferrer">
          the repository
        </a>
        . If anything on this page is contradicted by the code, the code is
        correct and the page is a bug - please report it as one.
      </P>
    </LegalPage>
  );
}
