import { ImageResponse } from 'next/og'

export const size = { width: 192, height: 192 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0d1e35 0%, #060b15 100%)',
          borderRadius: 40,
        }}
      >
        <span style={{ fontSize: 128, color: '#c9a84c', lineHeight: 1, fontFamily: 'serif' }}>
          ♠
        </span>
      </div>
    ),
    { ...size },
  )
}
