# @solcreek/runtime

## 0.4.2

- **React hooks follow the rules of React.** `LiveRoom` keeps its subscriber
  set and query cache in state instead of refs read during render.
  `useLiveQuery` syncs its option callbacks from an effect, derives
  `isConnected` from the room context, and updates state from promise
  callbacks rather than synchronously in the mount effect; `useQuery`'s
  `refetch` has the same shape. `usePresence` derives an explicit WebSocket URL
  from its options instead of mirroring it into state.
- **Stable `refetch` / `mutate` inside a `LiveRoom`.** The room fetch depends
  on the room id only, so its identity (and that of `refetch` and `mutate`)
  no longer changes when peers or connection state update.
- **Built with tsdown** instead of `tsc`. Same entry points (`.`, `./react`,
  `./hono`) and the same external imports (`d1-schema`, `react`); smaller
  output.
