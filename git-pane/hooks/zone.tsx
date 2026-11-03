import type { ClientModule } from 'claude-code'

export type ZoneProps = { columns: number; rows: number; boxes: [string, number, number, number, number][] }

const Zone: ClientModule<ZoneProps, Record<string, never>> = (props, surface) => {
  const { Box } = surface.elements
  surface.onPointer(e => {
    if (e.type !== 'down' || (e.button ?? 'left') !== 'left') return
    const x = e.fine?.x ?? e.x + 0.5
    const y = e.fine?.y ?? e.y + 0.5
    const box = [...props.boxes].reverse().find(([, x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)
    if (box) surface.post({ tab: box[0] })
  })
  surface.onKey(e => surface.post({ key: e.key, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift) }))
  return <Box width={props.columns} height={props.rows} />
}

export default Zone
