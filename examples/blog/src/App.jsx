const articles = [
  {
    title: "The Art of Slow Living",
    excerpt: "In a world that never stops moving, there's a quiet revolution brewing — one that asks us to pause, breathe, and savor the moment.",
    date: "Mar 15, 2026",
    category: "Lifestyle",
    gradient: "linear-gradient(135deg, #e07c4f 0%, #d4a574 50%, #c9b896 100%)",
  },
  {
    title: "Architecture of Tomorrow",
    excerpt: "How biophilic design is reshaping our cities, blending nature with concrete in ways we never imagined possible.",
    date: "Mar 12, 2026",
    category: "Design",
    gradient: "linear-gradient(135deg, #4a6741 0%, #7a9b6d 50%, #b8c9a3 100%)",
  },
  {
    title: "Notes on Modern Poetry",
    excerpt: "A resurgence in verse is sweeping through independent bookshops and late-night reading circles across the country.",
    date: "Mar 10, 2026",
    category: "Culture",
    gradient: "linear-gradient(135deg, #6b4c7a 0%, #9b7aab 50%, #c4a8d0 100%)",
  },
  {
    title: "Fermentation Revival",
    excerpt: "From kimchi to kombucha, ancient preservation techniques are finding new life in contemporary kitchens everywhere.",
    date: "Mar 8, 2026",
    category: "Food",
    gradient: "linear-gradient(135deg, #c4753b 0%, #e0a86e 50%, #f0d4a8 100%)",
  },
  {
    title: "The Vinyl Paradox",
    excerpt: "Why analog music formats continue to thrive in an age of infinite digital streaming and algorithmic playlists.",
    date: "Mar 5, 2026",
    category: "Music",
    gradient: "linear-gradient(135deg, #2c3e50 0%, #4a6580 50%, #7a9bb5 100%)",
  },
  {
    title: "Walking as Practice",
    excerpt: "Philosophers, artists, and scientists have long known what the rest of us are just rediscovering about the power of a simple walk.",
    date: "Mar 2, 2026",
    category: "Wellness",
    gradient: "linear-gradient(135deg, #8b6f4e 0%, #b8976a 50%, #d4c4a0 100%)",
  },
];

const styles = {
  body: {
    margin: 0,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#2c2418",
    backgroundColor: "#faf8f5",
    lineHeight: 1.6,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "1.25rem 3rem",
    borderBottom: "1px solid #e8e2d9",
    backgroundColor: "#faf8f5",
  },
  logo: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "1.75rem",
    fontWeight: 700,
    color: "#2c2418",
    letterSpacing: "-0.02em",
  },
  nav: {
    display: "flex",
    gap: "2rem",
  },
  navLink: {
    textDecoration: "none",
    color: "#6b5e50",
    fontSize: "0.95rem",
    fontWeight: 500,
    cursor: "pointer",
    transition: "color 0.2s",
  },
  hero: {
    background: "linear-gradient(135deg, #d4854a 0%, #e0a060 30%, #c9956b 60%, #a07850 100%)",
    padding: "5rem 3rem",
    position: "relative",
    overflow: "hidden",
  },
  heroContent: {
    maxWidth: "700px",
  },
  heroCategory: {
    display: "inline-block",
    backgroundColor: "rgba(255,255,255,0.2)",
    color: "#fff",
    padding: "0.3rem 0.85rem",
    borderRadius: "2rem",
    fontSize: "0.8rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: "1.25rem",
  },
  heroTitle: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "3rem",
    fontWeight: 700,
    color: "#fff",
    lineHeight: 1.15,
    margin: "0 0 1.25rem 0",
  },
  heroExcerpt: {
    color: "rgba(255,255,255,0.9)",
    fontSize: "1.15rem",
    lineHeight: 1.7,
    margin: "0 0 1.5rem 0",
    maxWidth: "600px",
  },
  heroMeta: {
    color: "rgba(255,255,255,0.75)",
    fontSize: "0.9rem",
  },
  section: {
    padding: "4rem 3rem",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  sectionTitle: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "1.75rem",
    fontWeight: 700,
    color: "#2c2418",
    marginBottom: "2rem",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
    gap: "2rem",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: "0.75rem",
    overflow: "hidden",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)",
    transition: "transform 0.2s, box-shadow 0.2s",
    cursor: "pointer",
  },
  cardImage: {
    height: "200px",
    width: "100%",
  },
  cardBody: {
    padding: "1.5rem",
  },
  cardCategory: {
    display: "inline-block",
    backgroundColor: "#f5efe7",
    color: "#9b7a4a",
    padding: "0.2rem 0.7rem",
    borderRadius: "2rem",
    fontSize: "0.75rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: "0.75rem",
  },
  cardTitle: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "1.25rem",
    fontWeight: 700,
    color: "#2c2418",
    margin: "0 0 0.6rem 0",
    lineHeight: 1.3,
  },
  cardExcerpt: {
    color: "#6b5e50",
    fontSize: "0.92rem",
    lineHeight: 1.6,
    margin: "0 0 1rem 0",
  },
  cardDate: {
    color: "#a09484",
    fontSize: "0.82rem",
  },
  footer: {
    borderTop: "1px solid #e8e2d9",
    padding: "2rem 3rem",
    textAlign: "center",
    color: "#a09484",
    fontSize: "0.88rem",
    backgroundColor: "#faf8f5",
  },
};

export default function App() {
  return (
    <div style={styles.body}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.logo}>The Pulse</div>
        <nav style={styles.nav}>
          <a style={styles.navLink} href="#">Home</a>
          <a style={styles.navLink} href="#">Articles</a>
          <a style={styles.navLink} href="#">About</a>
        </nav>
      </header>

      {/* Hero / Featured Article */}
      <section style={styles.hero}>
        <div style={styles.heroContent}>
          <div style={styles.heroCategory}>Featured</div>
          <h1 style={styles.heroTitle}>
            The Quiet Craft of Handwritten Letters
          </h1>
          <p style={styles.heroExcerpt}>
            In an era of instant messages and disappearing stories, a growing community of writers
            is rediscovering the intimacy and permanence of pen on paper — and changing how we
            think about connection.
          </p>
          <div style={styles.heroMeta}>
            By <strong style={{ color: "#fff" }}>Elena Morrow</strong> &middot; March 18, 2026
          </div>
        </div>
      </section>

      {/* Article Grid */}
      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Latest Articles</h2>
        <div style={styles.grid}>
          {articles.map((article, i) => (
            <article key={i} style={styles.card}>
              <div style={{ ...styles.cardImage, background: article.gradient }} />
              <div style={styles.cardBody}>
                <div style={styles.cardCategory}>{article.category}</div>
                <h3 style={styles.cardTitle}>{article.title}</h3>
                <p style={styles.cardExcerpt}>{article.excerpt}</p>
                <div style={styles.cardDate}>{article.date}</div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={styles.footer}>
        &copy; 2026 The Pulse. All rights reserved.
      </footer>
    </div>
  );
}
