"use client";

import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { Footer } from "@/components/footer";

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "",
    description: "Try Creek instantly. No account needed.",
    features: [
      "Sandbox deploys (60 min preview)",
      "Auto-detect frameworks",
      "CLI + API + MCP access",
      "Community support",
    ],
    cta: "npx creek deploy --demo",
    ctaStyle: "border" as const,
    highlight: false,
  },
  {
    name: "Starter",
    price: "$12",
    period: "/mo",
    description: "For indie devs and side projects.",
    features: [
      "Permanent deploys",
      "Custom domains + auto SSL",
      "No sandbox banner",
      "Environment variables",
      "5 projects",
    ],
    cta: "Get started",
    ctaStyle: "solid" as const,
    highlight: true,
    badge: "Popular",
  },
  {
    name: "Pro",
    price: "$20",
    period: "/seat/mo",
    description: "For teams shipping to production.",
    features: [
      "Everything in Starter",
      "Unlimited projects",
      "GitHub PR previews",
      "SSR on Workers",
      "Password-protected deploys",
      "Team collaboration",
      "Priority support",
    ],
    cta: "Start free trial",
    ctaStyle: "solid" as const,
    highlight: false,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For organizations with compliance needs.",
    features: [
      "Everything in Pro",
      "SSO (SAML / OIDC)",
      "Audit logs + SIEM export",
      "SLA guarantees",
      "Dedicated support",
      "Region lock (EU)",
    ],
    cta: "Contact us",
    ctaStyle: "border" as const,
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <div className="flex flex-col flex-1">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="mx-auto max-w-5xl flex items-center justify-between px-6 h-14">
          <a href="/" className="font-mono text-sm font-medium tracking-tight">
            creek
          </a>
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="/docs" className="hover:text-foreground transition-colors">Docs</a>
            <a href="/pricing" className="text-foreground">Pricing</a>
            <a href="/changelog" className="hover:text-foreground transition-colors">Changelog</a>
            <a href="https://github.com/solcreek/creek" className="hover:text-foreground transition-colors" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
        </div>
      </nav>

      {/* Header */}
      <section className="px-6 pt-20 pb-16 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          Simple, transparent pricing
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mt-4 text-muted-foreground max-w-md mx-auto"
        >
          Start free. Deploy instantly. Pay when you need permanent sites and custom domains.
        </motion.p>
      </section>

      {/* Grid */}
      <section className="mx-auto max-w-5xl px-6 pb-28">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.name}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.4 }}
              className={`relative rounded-xl border p-6 flex flex-col ${
                tier.highlight
                  ? "border-accent/40 bg-accent/[0.03]"
                  : "border-border"
              }`}
            >
              {tier.badge && (
                <span className="absolute -top-2.5 left-4 bg-accent text-background text-[10px] font-semibold px-2 py-0.5 rounded-full">
                  {tier.badge}
                </span>
              )}
              <h3 className="text-sm font-semibold">{tier.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-semibold tracking-tight">{tier.price}</span>
                {tier.period && <span className="text-sm text-muted-foreground">{tier.period}</span>}
              </div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{tier.description}</p>

              <ul className="mt-6 space-y-2.5 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Check className="size-3.5 mt-0.5 text-accent shrink-0" />
                    <span className="text-muted-foreground">{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-6">
                {tier.name === "Free" ? (
                  <div className="rounded-lg border border-border bg-code-bg px-3 py-2 font-mono text-xs text-muted-foreground text-center">
                    {tier.cta}
                  </div>
                ) : (
                  <a
                    href={tier.name === "Enterprise" ? "mailto:enterprise@creek.dev" : "https://app.creek.dev"}
                    className={`block w-full rounded-lg px-4 py-2 text-center text-sm font-medium transition-colors ${
                      tier.ctaStyle === "solid"
                        ? "bg-foreground text-background hover:opacity-90"
                        : "border border-border text-muted-foreground hover:text-foreground hover:border-foreground/20"
                    }`}
                  >
                    {tier.cta}
                  </a>
                )}
              </div>
            </motion.div>
          ))}
        </div>

        {/* FAQ-like note */}
        <div className="mt-12 text-center text-sm text-muted-foreground">
          <p>All plans include: CLI, API, MCP server, framework auto-detection, edge caching, SSL.</p>
          <p className="mt-1">
            Self-hosting is always free.{" "}
            <a href="/docs" className="text-accent hover:underline">Learn more</a>
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
