PYTHON ?= $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)
IVERILOG ?= iverilog
VVP ?= vvp
RTL := $(wildcard rtl/*.v)
.PHONY: test test-uart test-parser test-detector test-integration clean
build:
	mkdir -p build
build/tb_%: tb/tb_%.v $(RTL) | build
	$(IVERILOG) -g2001 -Wall -s tb_$* -o $@ $(RTL) $<
test-uart: build/tb_uart_rx build/tb_uart_tx
	$(VVP) build/tb_uart_rx
	$(VVP) build/tb_uart_tx
clean:
	rm -rf build
test-parser: build/tb_packet_parser build/tb_station_demux
	$(VVP) build/tb_packet_parser
	$(VVP) build/tb_station_demux
test-echo: vectors build/tb_echo
	$(VVP) build/tb_echo
.PHONY: vectors test-echo test-formatter test-faults test-tools
vectors: | build
	$(PYTHON) tools/generate_coefficients.py --check
	$(PYTHON) tools/generate_test_vectors.py
test-detector: vectors build/tb_correlator
	$(VVP) build/tb_correlator +INPUT=build/single.samples.hex +EXPECTED=build/single.expected.hex +SAMPLES=4837 +RESULTS=8
	$(VVP) build/tb_correlator +INPUT=build/numerical.samples.hex +EXPECTED=build/numerical.expected.hex +SAMPLES=19348 +RESULTS=32
build/tb_integration_uart: tb/tb_integration.v $(RTL) | build
	$(IVERILOG) -g2001 -Wall -s tb_integration -Ptb_integration.FAST=0 -o $@ $(RTL) $<
test-integration: vectors build/tb_integration build/tb_integration_uart
	$(VVP) build/tb_integration +INPUT=build/normal.hex +EXPECTED=build/normal.expected.hex +OUTPUT=build/normal.results.hex +BYTES=58800 +RESULTS=12
	$(VVP) build/tb_integration +INPUT=build/grid_oscillation.hex +EXPECTED=build/grid_oscillation.expected.hex +OUTPUT=build/grid_oscillation.results.hex +BYTES=58800 +RESULTS=12
	$(VVP) build/tb_integration +INPUT=build/isolated.hex +EXPECTED=build/isolated.expected.hex +OUTPUT=build/isolated.results.hex +BYTES=58800 +RESULTS=12
	$(VVP) build/tb_integration_uart +INPUT=build/uart.hex +EXPECTED=build/uart.expected.hex +OUTPUT=build/uart.results.hex +BYTES=16800 +RESULTS=4
test-formatter: build/tb_result_formatter
	$(VVP) build/tb_result_formatter
test-faults: vectors build/tb_faults
	$(VVP) build/tb_faults
test-tools: test-integration
	$(PYTHON) tools/test_tools.py
test: test-uart test-parser test-echo test-detector test-formatter test-faults test-tools test-jtag
	@echo "PASS all FPGA MVP tests"

.PHONY: test-jtag
build/tb_jtag: tb/tb_jtag.v $(RTL) | build
	$(IVERILOG) -g2001 -Wall -DDE1_VIRTUAL_JTAG -s tb_jtag -o $@ $(RTL) $<
test-jtag: vectors build/tb_jtag
	$(VVP) build/tb_jtag
