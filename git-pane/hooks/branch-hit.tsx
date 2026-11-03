import type { ClientModule } from 'claude-code'

// Laid over a branch row in the terminal. A pointer down inside a Client is the
// Client's until the up, so the terminal neither selects a word nor copies it:
// both clicks of a double click arrive, and a right click can be told apart.
// After filetree's hit.tsx (MIT, Kurt Buhler).
export type HitProps = { id: string }
type Local = { ref: { id: string; unpoint?: () => void } }

const Hit: ClientModule<HitProps, Local> = (props, surface) => {
  const { Box } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { ref: { id: props.id } }
    surface.setState(state)
  }
  const ref = state.ref
  ref.id = props.id
  ref.unpoint ??= surface.onPointer(e => {
    if (e.type === 'down' && e.button === 'right') surface.post({ menu: ref.id })
    // a press only where the button came up over the row: a drag away is no click
    else if (e.type === 'up' && (e.button ?? 'left') === 'left' && e.x >= 0 && e.y >= 0 && e.x < surface.columns && e.y < surface.rows)
      surface.post({ press: ref.id })
  })
  return <Box width="100%" height="100%" />
}

export default Hit
