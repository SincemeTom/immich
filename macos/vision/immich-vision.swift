// immich-vision: what Apple's Vision and Speech frameworks say about a photo or a video, for the server's content
// analysis (server/src/services/content-analysis.service.ts; macos/verification/m4-vision-research.md). The models
// are the system's, run on the Neural Engine; nothing ships with it.
//
// The server starts it once and keeps it: it reads one job per line on stdin, and writes each result as one line on
// stdout when it is done. Jobs run at once, so a long video does not hold up the photos after it: results come in the
// order they finish, each with its job's id. Videos are listened to SPEECH_AT_ONCE at a time, the rest in turn.
//
//   {"id": "...", "path": "/…/preview.jpeg", "tasks": ["classify", "aesthetics", "animals", "barcodes"]}
//   {"id": "...", "classify": [{"label": "cat", "confidence": 0.93}, …], "aesthetics": {"score": 0.41,
//    "utility": false}, "animals": [{"label": "Cat", "confidence": 0.88}], "barcodes": [{"payload": "…",
//    "symbology": "QR"}], "ms": 31}
//
// On macOS 26 also (`capabilities` says which this Mac has):
//   documents   a document in the picture, and its structure (RecognizeDocumentsRequest)
//   smudge      how likely the lens was smudged (DetectLensSmudgeRequest)
//   speech      what is said in a video, with when (SpeechAnalyzer); "path" is the video, "language" the language
//               spoken (default zh-CN), whose model macOS downloads the first time
//
// A request that fails leaves {"error": "…"} as its result; a job it cannot read, {"id": …, "error": "…"}.
//
//   immich-vision capabilities           {"version": 2, "macos": "15.6.0", "features": ["classify", …]}
//   immich-vision version                the same, in a line for people
//   immich-vision labels                 the classifier's labels, one per line
//   immich-vision extract-audio IN OUT   the sound of a video, as speech recognition reads it (16 kHz mono)
//
// Build: swiftc -O -parse-as-library -target arm64-apple-macos15.0 -o immich-vision immich-vision.swift

import AVFoundation
import CoreMedia
import Foundation
import Speech
import Vision

let HELPER_VERSION = 4

struct Job: Decodable {
    let id: String
    let path: String
    let tasks: [String]
    let language: String?
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

struct Segment: Sendable {
    let start: Double
    let end: Double
    let text: String
}

func milliseconds(since start: ContinuousClock.Instant) -> Int {
    let elapsed = ContinuousClock.now - start
    return Int((Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15).rounded())
}

func rounded(_ value: Float) -> Double {
    (Double(value) * 10000).rounded() / 10000
}

func rounded(_ value: Double) -> Double {
    (value * 100).rounded() / 100
}

/** what this Mac can do: macOS 26's requests only on macOS 26 */
func features() -> [String] {
    var features = ["classify", "aesthetics", "animals", "barcodes"]
    if #available(macOS 26.0, *) {
        features += ["documents", "smudge"]
        if SpeechTranscriber.isAvailable {
            features.append("speech")
        }
    }
    return features
}

func macOSVersion() -> String {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    return "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
}

// --- a video's sound ------------------------------------------------------------------------------------------------

/**
 * Where a video's sound is read. AVAssetReader's copyNextSampleBuffer blocks its thread until the decoder has the next
 * buffer, and Swift's tasks share one thread per core: as many videos at once as the Mac has cores blocked all of
 * them, and the helper with them, for good (macos/verification/m4-vision-speech-deadlock.md). So the reading is done
 * on threads of its own, which the tasks wait for without holding one.
 */
let audioQueue = DispatchQueue(label: "immich-vision.audio", qos: .utility, attributes: .concurrent)

/**
 * A number of slots, waited for without holding a thread: how many videos are listened to at once. Each takes a few
 * hundred MB and the Neural Engine, which more at once only share; the rest wait their turn here.
 */
actor Slots {
    private var free: Int
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init(_ count: Int) { free = count }

    func acquire() async {
        if free > 0 {
            free -= 1
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    func release() {
        if waiting.isEmpty {
            free += 1
        } else {
            waiting.removeFirst().resume()
        }
    }

    func with<T>(_ body: () async throws -> T) async rethrows -> T {
        await acquire()
        do {
            let value = try await body()
            release()
            return value
        } catch {
            release()
            throw error
        }
    }
}

let SPEECH_AT_ONCE = 2
let speechSlots = Slots(SPEECH_AT_ONCE)

/**
 * The first audio track of a video, as 16 kHz mono 16-bit PCM in a CAF file: what speech recognition reads, and
 * small (2 MB a minute). Its length in seconds; nil for a video without sound.
 */
func extractAudio(_ input: URL, to output: URL) async throws -> Double? {
    let asset = AVURLAsset(url: input)
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
        return nil
    }
    // the track goes to the reading thread and is used there only
    let source = Unchecked((asset, track))
    return try await withCheckedThrowingContinuation { continuation in
        audioQueue.async {
            continuation.resume(with: Result { try readAudio(source.value.0, track: source.value.1, to: output) })
        }
    }
}

/** a value handed to one other thread, which alone uses it from then on */
struct Unchecked<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/** extractAudio's reading, which blocks: on audioQueue only */
func readAudio(_ asset: AVURLAsset, track: AVAssetTrack, to output: URL) throws -> Double {
    let reader = try AVAssetReader(asset: asset)
    let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ])
    readerOutput.alwaysCopiesSampleData = false
    reader.add(readerOutput)
    guard reader.startReading() else {
        throw Failure("cannot read the sound: \(reader.error.map { "\($0)" } ?? "unknown")")
    }
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)
    else {
        throw Failure("no 16 kHz format")
    }
    let file = try AVAudioFile(forWriting: output, settings: format.settings, commonFormat: .pcmFormatInt16,
                               interleaved: true)
    var frames: AVAudioFramePosition = 0
    while let sample = readerOutput.copyNextSampleBuffer() {
        let count = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { continue }
        buffer.frameLength = count
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(count),
                                                                 into: buffer.mutableAudioBufferList)
        guard status == noErr else {
            throw Failure("cannot copy the sound (\(status))")
        }
        try file.write(from: buffer)
        frames += AVAudioFramePosition(count)
    }
    guard reader.status == .completed else {
        throw Failure("reading the sound stopped: \(reader.error.map { "\($0)" } ?? "\(reader.status.rawValue)")")
    }
    return Double(frames) / 16000
}

/** what is said in a video, in the language given, as segments with their times */
@available(macOS 26.0, *)
func transcribe(_ video: URL, language: String) async throws -> [String: Any] {
    let audio = FileManager.default.temporaryDirectory.appendingPathComponent("immich-vision-\(UUID().uuidString).caf")
    defer { try? FileManager.default.removeItem(at: audio) }
    guard let seconds = try await extractAudio(video, to: audio) else {
        return ["audio": false, "seconds": 0, "language": language, "segments": [] as [Any]]
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else {
        throw Failure("no speech recognition for \(language)")
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    // the language's model, which macOS downloads once and keeps
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collected = Task { () throws -> [Segment] in
        var segments: [Segment] = []
        for try await result in transcriber.results where result.isFinal {
            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                segments.append(Segment(start: result.range.start.seconds, end: result.range.end.seconds, text: text))
            }
        }
        return segments
    }
    let file = try AVAudioFile(forReading: audio)
    if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    let segments = try await collected.value
    return [
        "audio": true,
        "seconds": rounded(seconds),
        "language": locale.identifier(.bcp47),
        "segments": segments.map { ["start": rounded($0.start), "end": rounded($0.end), "text": $0.text] },
    ]
}

// --- a job ----------------------------------------------------------------------------------------------------------

func analyze(_ job: Job) async -> [String: Any] {
    var out: [String: Any] = ["id": job.id]
    guard FileManager.default.isReadableFile(atPath: job.path) else {
        out["error"] = "cannot read \(job.path)"
        return out
    }
    let url = URL(fileURLWithPath: job.path)
    let handler = ImageRequestHandler(url)
    let start = ContinuousClock.now
    for task in job.tasks {
        do {
            switch task {
            case "classify":
                let results = try await handler.perform(ClassifyImageRequest())
                out[task] = results.filter { $0.confidence >= 0.1 }.sorted { $0.confidence > $1.confidence }
                    .prefix(30).map { ["label": $0.identifier, "confidence": rounded($0.confidence)] }
            case "aesthetics":
                let result = try await handler.perform(CalculateImageAestheticsScoresRequest())
                out[task] = ["score": rounded(result.overallScore), "utility": result.isUtility]
            case "animals":
                out[task] = try await handler.perform(RecognizeAnimalsRequest()).compactMap { animal -> [String: Any]? in
                    guard let label = animal.labels.first else { return nil }
                    return ["label": label.identifier, "confidence": rounded(label.confidence)]
                }
            case "barcodes":
                out[task] = try await handler.perform(DetectBarcodesRequest()).compactMap { code -> [String: Any]? in
                    guard let payload = code.payloadString else { return nil }
                    return ["payload": payload, "symbology": "\(code.symbology)"]
                }
            case "documents":
                guard #available(macOS 26.0, *) else { throw Failure("needs macOS 26") }
                let documents = try await handler.perform(RecognizeDocumentsRequest())
                // the one Vision is surest of. On macOS 26-27 its confidence is 0 and its region the whole picture,
                // whatever the picture: how much of the picture its text covers tells a page from a street sign
                if let best = documents.max(by: { $0.confidence < $1.confidence }) {
                    let document = best.document
                    let title = document.title.map { $0.lines.compactMap { $0.topCandidates(1).first?.string } } ?? []
                    let textArea = document.text.lines.reduce(0.0) { sum, line in
                        sum + Double(line.boundingBox.width * line.boundingBox.height)
                    }
                    out[task] = [
                        "count": documents.count, "confidence": rounded(best.confidence),
                        "lines": document.text.lines.count, "paragraphs": document.paragraphs.count,
                        "tables": document.tables.count, "lists": document.lists.count,
                        "characters": document.text.transcript.count, "textArea": rounded(Float(min(textArea, 1))),
                        "title": title.joined(separator: " "),
                    ]
                } else {
                    out[task] = ["count": 0]
                }
            case "smudge":
                guard #available(macOS 26.0, *) else { throw Failure("needs macOS 26") }
                out[task] = ["confidence": rounded(try await handler.perform(DetectLensSmudgeRequest()).confidence)]
            case "speech":
                guard #available(macOS 26.0, *) else { throw Failure("needs macOS 26") }
                out[task] = try await speechSlots.with { try await transcribe(url, language: job.language ?? "zh-CN") }
            default:
                out[task] = ["error": "unknown task"]
            }
        } catch {
            out[task] = ["error": "\(error)"]
        }
    }
    out["ms"] = milliseconds(since: start)
    return out
}

/** one result per line, whole, whichever job finishes first */
actor Output {
    func write(_ object: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            ?? Data("{\"error\": \"unencodable result\"}".utf8)
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }
}

struct Line: @unchecked Sendable {
    let object: [String: Any]
}

@main
struct ImmichVision {
    static func main() async {
        let arguments = CommandLine.arguments
        if arguments.count > 1 {
            switch arguments[1] {
            case "capabilities":
                let info: [String: Any] = ["version": HELPER_VERSION, "macos": macOSVersion(), "features": features()]
                let data = try! JSONSerialization.data(withJSONObject: info, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self))
            case "version":
                let labels = ClassifyImageRequest().supportedIdentifiers.count
                print("immich-vision \(HELPER_VERSION), macOS \(macOSVersion()), \(labels) labels; \(features().joined(separator: ", "))")
            case "labels":
                print(ClassifyImageRequest().supportedIdentifiers.joined(separator: "\n"))
            case "extract-audio" where arguments.count == 4:
                do {
                    let seconds = try await extractAudio(URL(fileURLWithPath: arguments[2]),
                                                         to: URL(fileURLWithPath: arguments[3]))
                    print(seconds.map { "\(rounded($0)) s" } ?? "no sound")
                } catch {
                    FileHandle.standardError.write(Data("extract-audio: \(error)\n".utf8))
                    exit(1)
                }
            default:
                FileHandle.standardError.write(
                    Data("usage: immich-vision [capabilities | version | labels | extract-audio IN OUT]\n".utf8))
                exit(64)
            }
            return
        }
        let output = Output()
        let decoder = JSONDecoder()
        // stdin is read without blocking the main thread, which some of the frameworks call back on; and the jobs are
        // let go as they finish (a task group keeps their results until it is asked for them)
        await withDiscardingTaskGroup { group in
            do {
                for try await line in FileHandle.standardInput.bytes.lines {
                    guard !line.isEmpty else { continue }
                    guard let job = try? decoder.decode(Job.self, from: Data(line.utf8)) else {
                        let id = (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["id"]
                        await output.write(["id": id ?? NSNull(), "error": "not a job"])
                        continue
                    }
                    group.addTask {
                        let result = Line(object: await analyze(job))
                        await output.write(result.object)
                    }
                }
            } catch {
                FileHandle.standardError.write(Data("reading stdin: \(error)\n".utf8))
            }
        }
    }
}
