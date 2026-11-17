// mic-monitor
//
// Prints one JSON line on stdout whenever the set of apps that are recording from a
// microphone changes, for example:
//
//     {"input":[{"bundleId":"com.google.Chrome.helper","pid":4711}]}
//
// It uses CoreAudio's process objects (macOS 14+). It only reads *which* processes are
// capturing audio, never the audio itself, so it needs no microphone permission.
// On older macOS versions it prints {"unsupported":true} once and exits.
//
// Built by build/build-mic-monitor.js; started and read by src/meeting-detector.js.

import CoreAudio
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let pollInterval: TimeInterval = 2.0

func globalAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    return AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

func readUInt32(_ objectId: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = globalAddress(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let status = AudioObjectGetPropertyData(objectId, &address, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

func readInt32(_ objectId: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Int32? {
    var address = globalAddress(selector)
    var value: Int32 = 0
    var size = UInt32(MemoryLayout<Int32>.size)
    let status = AudioObjectGetPropertyData(objectId, &address, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

func readString(_ objectId: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = globalAddress(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(objectId, &address, 0, nil, &size, pointer)
    }
    guard status == noErr, let string = value?.takeRetainedValue() else { return nil }
    return string as String
}

@available(macOS 14.0, *)
func audioProcessObjects() -> [AudioObjectID] {
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    var address = globalAddress(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &address, 0, nil, &size) == noErr, size > 0 else {
        return []
    }
    var objectIds = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    let status = objectIds.withUnsafeMutableBufferPointer { buffer in
        AudioObjectGetPropertyData(systemObject, &address, 0, nil, &size, buffer.baseAddress!)
    }
    guard status == noErr else { return [] }
    return Array(objectIds.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
}

struct InputProcess: Hashable {
    let bundleId: String
    let pid: Int32
}

@available(macOS 14.0, *)
func processesUsingInput() -> Set<InputProcess> {
    var result = Set<InputProcess>()
    for objectId in audioProcessObjects() {
        guard let isRunningInput = readUInt32(objectId, kAudioProcessPropertyIsRunningInput), isRunningInput != 0 else {
            continue
        }
        let bundleId = readString(objectId, kAudioProcessPropertyBundleID) ?? ""
        let pid = readInt32(objectId, kAudioProcessPropertyPID) ?? -1
        result.insert(InputProcess(bundleId: bundleId, pid: pid))
    }
    return result
}

func jsonString(_ text: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [text], options: [])
    let wrapped = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(wrapped.dropFirst().dropLast())
}

func printState(_ processes: Set<InputProcess>) {
    let items = processes
        .sorted { ($0.bundleId, $0.pid) < ($1.bundleId, $1.pid) }
        .map { "{\"bundleId\":\(jsonString($0.bundleId)),\"pid\":\($0.pid)}" }
    print("{\"input\":[\(items.joined(separator: ","))]}")
}

@available(macOS 14.0, *)
func run() -> Never {
    let parentPid = getppid()
    var lastState: Set<InputProcess>? = nil
    while true {
        // Stop when Keito Bar is gone (we get re-parented to launchd).
        if getppid() != parentPid { exit(0) }

        let state = processesUsingInput()
        if state != lastState {
            printState(state)
            lastState = state
        }
        Thread.sleep(forTimeInterval: pollInterval)
    }
}

if #available(macOS 14.0, *) {
    run()
} else {
    print("{\"unsupported\":true}")
    exit(0)
}
