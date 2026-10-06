import type { ClientModule } from 'claude-code'

type Props = { color: string }

// An invisible hit area laid over a swatch: a click released on it picks the swatch's color
const Tile: ClientModule<Props> = (props, surface) => {
  surface.onPointer(event => {
    const isInside = event.x >= 0 && event.y >= 0 && event.x < surface.columns && event.y < surface.rows
    if (event.type === 'up' && event.button === 'left' && isInside) {
      surface.post({ pick: props.color })
    }
  })

  const { Box } = surface.elements

  return <Box />
}

export default Tile
