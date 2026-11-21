create_clock -name CLOCK_50 -period 20.000 [get_ports {CLOCK_50}]
derive_clock_uncertainty

# Raw reset asserts asynchronously; all internal reset release is synchronized.
set_false_path -from [get_ports {RESET_N}]

# LEDs have no external synchronous capture clock. These zero-delay
# output constraints bound clock-to-pin routing within one 20 ns system period.
set_output_delay -clock CLOCK_50 -max 0.000 [get_ports {LEDR[*] LEDG[*]}]
set_output_delay -clock CLOCK_50 -min 0.000 [get_ports {LEDR[*] LEDG[*]}]
