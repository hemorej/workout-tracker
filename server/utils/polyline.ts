/**
 * Decodes a Google-encoded polyline (the format Strava's `map.summary_polyline`
 * / `map.polyline` fields use) into an array of [lat, lng] pairs.
 */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = []
  let index = 0
  let lat = 0
  let lng = 0

  // Each point is two varints (lat then lng), stored as signed deltas from the
  // previous point. Per chunk: strip the 63 offset, take 5 payload bits, and
  // keep consuming bytes while the 0x20 continuation bit is set. The assembled
  // integer is zig-zag encoded (LSB = sign), and values are fixed-point ×1e5.
  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let b: number
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1) // zig-zag decode, add delta

    result = 0
    shift = 0
    do {
      b = encoded.charCodeAt(index++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lng += (result & 1) ? ~(result >> 1) : (result >> 1)

    points.push([lat / 1e5, lng / 1e5])
  }

  return points
}
