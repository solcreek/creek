export default function App() {
  const styles = {
    page: {
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      background: "#0f172a",
      color: "#f1f5f9",
      minHeight: "100vh",
      margin: 0,
    },
    nav: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "1rem 2rem",
      borderBottom: "1px solid #1e293b",
      maxWidth: "1200px",
      margin: "0 auto",
    },
    logo: {
      fontSize: "1.5rem",
      fontWeight: 800,
      letterSpacing: "-0.02em",
      background: "linear-gradient(135deg, #3b82f6, #60a5fa)",
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
    },
    navLinks: {
      display: "flex",
      gap: "2rem",
      listStyle: "none",
      margin: 0,
      padding: 0,
    },
    navLink: {
      color: "#94a3b8",
      textDecoration: "none",
      fontSize: "0.9rem",
      cursor: "pointer",
    },
    ctaButton: {
      background: "#3b82f6",
      color: "#fff",
      border: "none",
      padding: "0.6rem 1.4rem",
      borderRadius: "8px",
      fontWeight: 600,
      fontSize: "0.9rem",
      cursor: "pointer",
    },
    hero: {
      textAlign: "center",
      padding: "5rem 2rem 3rem",
      maxWidth: "1200px",
      margin: "0 auto",
    },
    headline: {
      fontSize: "3.5rem",
      fontWeight: 800,
      letterSpacing: "-0.03em",
      margin: "0 0 1rem",
      lineHeight: 1.1,
    },
    subtitle: {
      fontSize: "1.2rem",
      color: "#94a3b8",
      maxWidth: "600px",
      margin: "0 auto 3rem",
      lineHeight: 1.6,
    },
    dashboard: {
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "1rem",
      maxWidth: "800px",
      margin: "0 auto",
    },
    statCard: {
      background: "#1e293b",
      borderRadius: "12px",
      padding: "1.5rem",
      textAlign: "left",
      border: "1px solid #334155",
    },
    statLabel: {
      fontSize: "0.8rem",
      color: "#64748b",
      marginBottom: "0.5rem",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
    },
    statValue: {
      fontSize: "1.8rem",
      fontWeight: 700,
    },
    section: {
      maxWidth: "1200px",
      margin: "0 auto",
      padding: "5rem 2rem",
    },
    sectionTitle: {
      textAlign: "center",
      fontSize: "2.2rem",
      fontWeight: 700,
      marginBottom: "3rem",
      letterSpacing: "-0.02em",
    },
    featuresGrid: {
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gap: "1.5rem",
    },
    featureCard: {
      background: "#1e293b",
      borderRadius: "12px",
      padding: "2rem",
      border: "1px solid #334155",
    },
    featureEmoji: {
      fontSize: "2rem",
      marginBottom: "1rem",
      display: "block",
    },
    featureTitle: {
      fontSize: "1.2rem",
      fontWeight: 600,
      marginBottom: "0.5rem",
    },
    featureDesc: {
      color: "#94a3b8",
      fontSize: "0.95rem",
      lineHeight: 1.6,
    },
    pricingGrid: {
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gap: "1.5rem",
      alignItems: "start",
    },
    pricingCard: {
      background: "#1e293b",
      borderRadius: "12px",
      padding: "2.5rem 2rem",
      border: "1px solid #334155",
      textAlign: "center",
    },
    pricingCardPro: {
      background: "#1e293b",
      borderRadius: "12px",
      padding: "2.5rem 2rem",
      border: "2px solid #3b82f6",
      textAlign: "center",
      position: "relative",
    },
    pricingTier: {
      fontSize: "1.1rem",
      fontWeight: 600,
      marginBottom: "0.5rem",
    },
    pricingPrice: {
      fontSize: "2.5rem",
      fontWeight: 800,
      margin: "1rem 0",
    },
    pricingPeriod: {
      fontSize: "1rem",
      color: "#64748b",
      fontWeight: 400,
    },
    pricingFeatures: {
      listStyle: "none",
      padding: 0,
      margin: "1.5rem 0",
      textAlign: "left",
    },
    pricingFeatureItem: {
      padding: "0.4rem 0",
      color: "#94a3b8",
      fontSize: "0.9rem",
    },
    pricingButton: {
      background: "transparent",
      color: "#3b82f6",
      border: "1px solid #3b82f6",
      padding: "0.7rem 2rem",
      borderRadius: "8px",
      fontWeight: 600,
      fontSize: "0.9rem",
      cursor: "pointer",
      width: "100%",
    },
    pricingButtonPrimary: {
      background: "#3b82f6",
      color: "#fff",
      border: "1px solid #3b82f6",
      padding: "0.7rem 2rem",
      borderRadius: "8px",
      fontWeight: 600,
      fontSize: "0.9rem",
      cursor: "pointer",
      width: "100%",
    },
  };

  const stats = [
    { label: "Users", value: "12.4K" },
    { label: "Retention", value: "89%" },
    { label: "Revenue", value: "$48.2K" },
    { label: "Load Time", value: "3.2s" },
  ];

  const features = [
    {
      emoji: "\u{1F4CA}",
      title: "Real-time Analytics",
      desc: "Monitor your key metrics as they happen with live dashboards that update every second.",
    },
    {
      emoji: "\u{1F512}",
      title: "Privacy First",
      desc: "All data is anonymized and encrypted. GDPR and CCPA compliant out of the box.",
    },
    {
      emoji: "\u{26A1}",
      title: "Lightning Fast",
      desc: "Sub-second query times on billions of events. Built on a modern columnar database.",
    },
  ];

  const pricingTiers = [
    {
      name: "Free",
      price: "$0",
      period: "/mo",
      features: ["Up to 1K events/mo", "1 dashboard", "7-day retention", "Community support"],
      primary: false,
    },
    {
      name: "Pro",
      price: "$29",
      period: "/mo",
      features: ["Up to 1M events/mo", "Unlimited dashboards", "1-year retention", "Priority support", "Custom alerts"],
      primary: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      period: "",
      features: ["Unlimited events", "Unlimited dashboards", "Unlimited retention", "Dedicated support", "SSO & SAML", "SLA guarantee"],
      primary: false,
    },
  ];

  return (
    <div style={styles.page}>
      {/* Nav */}
      <nav style={styles.nav}>
        <span style={styles.logo}>Metrix</span>
        <ul style={styles.navLinks}>
          <li><a style={styles.navLink} href="#features">Features</a></li>
          <li><a style={styles.navLink} href="#pricing">Pricing</a></li>
          <li><a style={styles.navLink} href="#docs">Docs</a></li>
        </ul>
        <button style={styles.ctaButton}>Get Started</button>
      </nav>

      {/* Hero */}
      <section style={styles.hero}>
        <h1 style={styles.headline}>Analytics that make sense</h1>
        <p style={styles.subtitle}>
          Understand your users, track what matters, and make data-driven decisions
          without the complexity. Set up in minutes, not days.
        </p>
        <div style={styles.dashboard}>
          {stats.map((s) => (
            <div key={s.label} style={styles.statCard}>
              <div style={styles.statLabel}>{s.label}</div>
              <div style={styles.statValue}>{s.value}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" style={styles.section}>
        <h2 style={styles.sectionTitle}>Why teams choose Metrix</h2>
        <div style={styles.featuresGrid}>
          {features.map((f) => (
            <div key={f.title} style={styles.featureCard}>
              <span style={styles.featureEmoji}>{f.emoji}</span>
              <div style={styles.featureTitle}>{f.title}</div>
              <div style={styles.featureDesc}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" style={styles.section}>
        <h2 style={styles.sectionTitle}>Simple, transparent pricing</h2>
        <div style={styles.pricingGrid}>
          {pricingTiers.map((t) => (
            <div key={t.name} style={t.primary ? styles.pricingCardPro : styles.pricingCard}>
              <div style={styles.pricingTier}>{t.name}</div>
              <div style={styles.pricingPrice}>
                {t.price}
                <span style={styles.pricingPeriod}>{t.period}</span>
              </div>
              <ul style={styles.pricingFeatures}>
                {t.features.map((feat) => (
                  <li key={feat} style={styles.pricingFeatureItem}>
                    {"\u2713"} {feat}
                  </li>
                ))}
              </ul>
              <button style={t.primary ? styles.pricingButtonPrimary : styles.pricingButton}>
                {t.name === "Enterprise" ? "Contact Us" : "Get Started"}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
