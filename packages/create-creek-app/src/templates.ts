/**
 * Template catalog — used for --list, interactive prompt, and gallery.
 *
 * Four types by output:
 *   site      — Visual pages (deploy → shareable URL)
 *   app       — Interactive UI + backend logic
 *   workflow  — Background process (no/minimal UI), trigger + steps
 *   connector — Data bridge pattern (ingestion → storage)
 */

export interface Template {
  name: string;
  description: string;
  type: "site" | "app" | "workflow" | "connector" | "developer";
  capabilities: string[];
  trigger?: string;
}

export const TEMPLATES: Template[] = [
  // --- Sites (Level 4 — deploy → shareable) ---
  { name: "landing",     description: "Landing page with hero and CTA",                        type: "site",      capabilities: [] },
  { name: "blog",        description: "Blog with image uploads",                                type: "site",      capabilities: ["database", "storage"] },
  { name: "link-in-bio", description: "Social links page",                                     type: "site",      capabilities: [] },
  { name: "waitlist",    description: "Waitlist with AI user segmentation",                     type: "site",      capabilities: ["database", "ai"] },

  // --- Apps (Level 3 — working data pipeline + UI) ---
  { name: "form",           description: "Form collector with admin dashboard",                 type: "app",       capabilities: ["database"] },
  { name: "dashboard",      description: "Data dashboard with scheduled refresh",               type: "app",       capabilities: ["database", "realtime", "cron"] },
  { name: "chatbot",        description: "AI chatbot with conversation history",                type: "app",       capabilities: ["database", "ai"] },
  { name: "survey",         description: "Survey with AI-powered analysis",                     type: "app",       capabilities: ["database", "ai"] },
  { name: "knowledge-base", description: "Knowledge base with AI search",                       type: "app",       capabilities: ["database", "ai", "storage"] },
  { name: "status-page",    description: "Service status page with uptime monitoring",          type: "app",       capabilities: ["database", "realtime", "cron", "cache"] },
  { name: "file-share",     description: "File upload/download with expiring links",            type: "app",       capabilities: ["database", "storage"] },
  { name: "todo",           description: "Realtime todo app (learning example)",                type: "app",       capabilities: ["database", "realtime"] },

  // --- Workflows (Level 2-3 — trigger + steps, no/minimal UI) ---
  { name: "approval-flow",      description: "Approval workflow — leave, expense, procurement", type: "workflow",   capabilities: ["database", "realtime", "queue"],          trigger: "webhook" },
  { name: "invoice-processor",  description: "Email invoice → AI extract → DB → notify",       type: "workflow",   capabilities: ["database", "ai", "storage", "email"],          trigger: "email" },
  { name: "scheduled-report",   description: "Scheduled query → AI summary → PDF report",      type: "workflow",   capabilities: ["database", "ai", "storage", "cron"],           trigger: "cron" },
  { name: "data-sync",          description: "Scheduled API pull → diff → DB → notify",        type: "workflow",   capabilities: ["database", "cron"],                        trigger: "cron" },
  { name: "ai-classifier",      description: "Input → AI classify → route to queue",           type: "workflow",   capabilities: ["database", "ai", "queue"],                 trigger: "webhook" },

  // --- Connectors (Level 2 — pure platform wiring) ---
  { name: "api",              description: "REST API with Hono",                                type: "connector", capabilities: ["database"],                                 trigger: "http" },
  { name: "webhook-receiver", description: "Receive and process external webhooks",             type: "connector", capabilities: ["database", "queue"],                        trigger: "webhook" },
  { name: "email-to-db",     description: "Email → parse → attachments to R2 → DB",            type: "connector", capabilities: ["database", "storage", "email"],                  trigger: "email" },
  { name: "ftp-sync",        description: "Scheduled FTP/SFTP pull → parse → DB",              type: "connector", capabilities: ["database", "storage", "cron", "ftp"],            trigger: "cron" },

  // --- Developer ---
  { name: "blank",           description: "Minimal Creek project (empty canvas)",               type: "developer", capabilities: [] },
];

export type TemplateName = (typeof TEMPLATES)[number]["name"];
export type TemplateType = Template["type"];
