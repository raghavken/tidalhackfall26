package require ::quartus::jtag

proc scan_mailbox {value} {
    set response [device_virtual_dr_shift -instance_index 0 -length 128 -value_in_hex -dr_value $value]
    if {![regexp -nocase {^a7(0[0-7])([0-9a-f]{28})$} $response -> flags result]} {
        error "Unexpected Virtual JTAG reply: $response"
    }
    scan $flags %x status
    return [list $status $result]
}

proc exchange {{command 0} {packet ""}} {
    set nop [string repeat 0 32]
    if {$command != 0} {
        set body ""
        foreach byte [regexp -all -inline {..} $packet] { set body $byte$body }
        set value [string map {" " 0} [format "%016s%02x%014s" "" $command $body]]
        lassign [scan_mailbox $value] status result
        if {!($status & 1)} { error "FPGA mailbox was busy before command $command" }
    }
    for {set attempt 0} {$attempt < 100} {incr attempt} {
        lassign [scan_mailbox $nop] status result
        if {$status & 1} { return [list $status $result] }
    }
    error "FPGA mailbox did not acknowledge command $command (status $status)"
}

proc drain_result {} {
    for {set attempt 0} {$attempt < 100} {incr attempt} {
        lassign [exchange] status result
        if {$status & 4} { error "FPGA latched a stream error" }
        if {$status & 2} {
            set packet ""
            foreach byte [regexp -all -inline {..} $result] { set packet $byte$packet }
            exchange 3
            return $packet
        }
    }
    error "Timed out waiting for a hardware result"
}

proc emit {event} {
    global events
    puts $events $event
    flush $events
}

proc replay {filename} {
    set input [open $filename rb]
    fconfigure $input -translation binary
    exchange
    exchange 2
    set count 0
    while {[string length [set data [read $input 7]]] != 0} {
        if {[string length $data] != 7} { error "Truncated measurement" }
        binary scan $data H* packet
        lassign [exchange 1 $packet] status ignored
        if {$status & 4} { error "FPGA latched a stream error" }
        incr count
        if {$count % 120 == 0 || $count == 1} {
            emit "SENT $count $packet"
        }
        if {$count % 2400 == 0} {
            for {set station 0} {$station < 4} {incr station} {
                emit "RECEIVED [drain_result]"
            }
        }
    }
    close $input
    lassign [exchange] status ignored
    if {$status & 4} { error "FPGA latched a stream error" }
    if {$status & 2} { error "FPGA returned an unexpected extra result" }
    emit "COMPLETE $count"
}

set cable ""
foreach candidate [get_hardware_names] {
    if {[string match "USB-Blaster*" $candidate]} {
        set cable $candidate
        break
    }
}
if {$cable eq ""} { error "USB-Blaster cable not found" }
set device ""
foreach candidate [get_device_names -hardware_name $cable] {
    if {[string match "*020B30DD*" $candidate]} {
        set device $candidate
        break
    }
}
if {$device eq ""} { error "Cyclone II EP2C20 missing from $cable JTAG chain: [get_device_names -hardware_name $cable]" }
open_device -hardware_name $cable -device_name $device
device_lock -timeout 10000
set events stdout
set event_path [lindex $quartus(args) 1]
set failed [catch {
    if {$event_path ne ""} { set events [open $event_path w] }
    device_virtual_ir_shift -instance_index 0 -ir_value 1 -no_captured_ir_value
    replay [lindex $quartus(args) 0]
} message]
device_unlock
close_device
if {$failed} { emit "ERROR [lindex [split $message \n] 0]" }
if {$events ne "stdout"} { close $events }
if {$failed} { error $message }
