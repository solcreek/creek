export default function App() {
  return (
    <div style={{ margin: 0, fontFamily: "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif", color: "#1e293b", background: "#f8fafc", minHeight: "100vh" }}>
      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #f8fafc; }
        a { color: #6366f1; text-decoration: none; transition: color 0.2s; }
        a:hover { color: #4338ca; }
      `}</style>

      {/* Nav */}
      <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1.5rem 2.5rem", maxWidth: 1100, margin: "0 auto" }}>
        <span style={{ fontWeight: 700, fontSize: "1.25rem", color: "#4f46e5" }}>AC</span>
        <div style={{ display: "flex", gap: "2rem", fontSize: "0.95rem" }}>
          {["About", "Projects", "Contact"].map(s => (
            <a key={s} href={`#${s.toLowerCase()}`} style={{ color: "#475569", fontWeight: 500 }}>{s}</a>
          ))}
        </div>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "6rem 2.5rem 4rem", textAlign: "center" }}>
        <p style={{ fontSize: "1rem", fontWeight: 600, color: "#6366f1", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "1rem" }}>Product Designer</p>
        <h1 style={{ fontSize: "clamp(2.5rem, 6vw, 4rem)", fontWeight: 800, color: "#0f172a", lineHeight: 1.1, marginBottom: "1.5rem" }}>
          Hi, I'm <span style={{ color: "#4f46e5" }}>Aria Chen</span>
        </h1>
        <p style={{ fontSize: "1.25rem", color: "#64748b", maxWidth: 600, margin: "0 auto", lineHeight: 1.7 }}>
          I craft thoughtful digital experiences that balance beauty and usability. Currently designing products that make complex workflows feel effortless.
        </p>
      </section>

      {/* About */}
      <section id="about" style={{ maxWidth: 760, margin: "0 auto", padding: "4rem 2.5rem" }}>
        <h2 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#0f172a", marginBottom: "1.25rem" }}>About</h2>
        <p style={{ fontSize: "1.1rem", color: "#475569", lineHeight: 1.8 }}>
          I'm a product designer with over 8 years of experience working at the intersection of design and technology. I've led design for startups and Fortune 500 companies alike, specializing in design systems, interaction design, and user research. When I'm not pushing pixels, you'll find me sketching at coffee shops, experimenting with ceramics, or hiking the Pacific coast. I believe great design is invisible — it just works.
        </p>
      </section>

      {/* Projects */}
      <section id="projects" style={{ maxWidth: 1100, margin: "0 auto", padding: "4rem 2.5rem" }}>
        <h2 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#0f172a", marginBottom: "2rem" }}>Projects</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "2rem" }}>
          {[
            { title: "Lumina Dashboard", desc: "A data analytics platform redesign focusing on clarity and speed. Reduced user task completion time by 40%.", gradient: "linear-gradient(135deg, #6366f1 0%, #a78bfa 100%)" },
            { title: "Pocket Garden", desc: "A mobile app helping urban dwellers grow plants indoors. Featured in Apple's 'Apps We Love'.", gradient: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)" },
            { title: "Threadline", desc: "A collaborative whiteboarding tool built for remote design teams. Used by 12,000+ designers worldwide.", gradient: "linear-gradient(135deg, #4f46e5 0%, #1e293b 100%)" },
          ].map((p) => (
            <div key={p.title} style={{ background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)", transition: "transform 0.2s, box-shadow 0.2s" }}>
              <div style={{ height: 200, background: p.gradient, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: "2.5rem", color: "rgba(255,255,255,0.3)", fontWeight: 800 }}>&#9670;</span>
              </div>
              <div style={{ padding: "1.5rem" }}>
                <h3 style={{ fontSize: "1.2rem", fontWeight: 700, color: "#0f172a", marginBottom: "0.5rem" }}>{p.title}</h3>
                <p style={{ fontSize: "0.95rem", color: "#64748b", lineHeight: 1.6 }}>{p.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Contact */}
      <section id="contact" style={{ maxWidth: 760, margin: "0 auto", padding: "4rem 2.5rem 6rem", textAlign: "center" }}>
        <h2 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#0f172a", marginBottom: "1rem" }}>Get in Touch</h2>
        <p style={{ fontSize: "1.1rem", color: "#64748b", marginBottom: "2rem", lineHeight: 1.7 }}>
          Interested in working together? I'd love to hear from you.
        </p>
        <div style={{ display: "flex", justifyContent: "center", gap: "2rem", flexWrap: "wrap", fontSize: "1rem" }}>
          <a href="mailto:aria@example.com">aria@example.com</a>
          <a href="https://twitter.com" target="_blank" rel="noopener noreferrer">Twitter</a>
          <a href="https://dribbble.com" target="_blank" rel="noopener noreferrer">Dribbble</a>
          <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer">LinkedIn</a>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ textAlign: "center", padding: "2rem", borderTop: "1px solid #e2e8f0", fontSize: "0.875rem", color: "#94a3b8" }}>
        &copy; 2026 Aria Chen. Designed with care.
      </footer>
    </div>
  );
}
