import { ImageResponse } from 'next/og'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // iOS rounds the corners itself; fill the whole square
          background: 'linear-gradient(135deg, #0d1e35 0%, #060b15 100%)',
        }}
      >
        <span style={{ fontSize: 120, color: '#c9a84c', lineHeight: 1, fontFamily: 'serif' }}>
          ♠
        </span>
      </div>
    ),
    { ...size },
  )
}
