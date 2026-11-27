-- A team's Cloudflare grant now lives in its CloudflareGrant Durable Object
-- (one per team), which serialises token refreshes in memory instead of the
-- lease, owner and generation columns cloudflare_connection used.
--
-- cloudflare_grant keeps only what the dashboard shows, never a token. The
-- object is its only writer.
--
-- Additive on purpose: cloudflare_connection is left in place, unread, and is
-- dropped by a later migration once the object path has run in production.
-- Grants stored there are not carried over (one test grant existed); a team
-- reconnects.
CREATE TABLE `cloudflare_grant` (
  `teamId` text PRIMARY KEY NOT NULL,
  `connectedByUserId` text,
  `grantedScopes` text NOT NULL,
  `accounts` text NOT NULL DEFAULT '[]',
  `needsReauth` integer NOT NULL DEFAULT 0,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL,
  FOREIGN KEY (`teamId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connectedByUserId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
