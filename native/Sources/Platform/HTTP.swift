import Foundation

func boundedResponse(_ request: URLRequest, session: URLSession = .shared, maximum: Int) async throws -> (Data, HTTPURLResponse) {
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse, response.url?.scheme == "https", (200..<300).contains(http.statusCode), response.expectedContentLength <= Int64(maximum) else {
        throw AppError("The HTTPS request failed or returned an oversized response.")
    }
    var data = Data()
    data.reserveCapacity(min(maximum, max(0, Int(response.expectedContentLength))))
    for try await byte in bytes {
        guard data.count < maximum else { throw AppError("The HTTPS response exceeded the size limit.") }
        data.append(byte)
    }
    return (data, http)
}
