import { Type, type Static } from '@core/utils/typeboxHelpers'

export const VideoPropsSchema = Type.Object({
  videoUrl: Type.String({ default: '' }),
  poster: Type.String({ default: '' }),
  autoplay: Type.Boolean({ default: false }),
  loop: Type.Boolean({ default: false }),
  muted: Type.Boolean({ default: false }),
  controls: Type.Boolean({ default: true }),
  playsinline: Type.Boolean({ default: true }),
  preload: Type.Union(
    [Type.Literal('none'), Type.Literal('metadata'), Type.Literal('auto')],
    { default: 'metadata' },
  ),
})

export type VideoStoredProps = Static<typeof VideoPropsSchema>
