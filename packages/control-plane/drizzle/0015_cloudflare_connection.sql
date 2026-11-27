-- "Connect Cloudflare": a team's OAuth grant to its own Cloudflare account(s).
--
-- Creek manages Access applications and DNS in the customer's account through
-- this grant, so Zero Trust seats are billed to the customer, not to Creek.
--
-- cloudflare_oauth_state holds an authorization request between the redirect
-- to Cloudflare and the callback: the PKCE verifier, and who started it (the
-- callback refuses a different signed-in user, so a forwarded consent link
-- cannot attach someone else's Cloudflare account to a team). Rows are
-- single-use and expire after ten minutes.
--
-- cloudflare_connection is one grant per team. Tokens are AES-GCM encrypted
-- with ENCRYPTION_KEY. generation and refreshLeaseUntil serialise refreshes:
-- Cloudflare rotates refresh tokens, so two concurrent refreshes would spend
-- the same token and lose the grant. generation is a fresh random value on
-- every write (connect, reconnect, refresh) — never a counter, which would
-- restart at 1 after a disconnect and let a refresh begun against the old
-- grant match the new one.
CREATE TABLE `cloudflare_oauth_state` (
  `state` text PRIMARY KEY NOT NULL,
  `teamId` text NOT NULL,
  `userId` text NOT NULL,
  `codeVerifier` text NOT NULL,
  `returnTo` text,
  `expiresAt` integer NOT NULL,
  FOREIGN KEY (`teamId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `cloudflare_connection` (
  `teamId` text PRIMARY KEY NOT NULL,
  `connectedByUserId` text,
  `encryptedAccessToken` text NOT NULL,
  `encryptedRefreshToken` text,
  `accessTokenExpiresAt` integer,
  `grantedScopes` text NOT NULL,
  `accounts` text NOT NULL DEFAULT '[]',
  `generation` text NOT NULL,
  `refreshLeaseUntil` integer,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL,
  FOREIGN KEY (`teamId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`connectedByUserId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
