`timescale 1ns/1ps
module top #(
    parameter CLOCK_HZ = 50000000,
    parameter BAUD = 115200,
    parameter [54:0] ENERGY_THRESHOLD = 55'd2250000
)(input wire CLOCK_50, input wire RESET_N, input wire MODE,
  input wire UART_RXD, output wire UART_TXD,
  output wire [5:0] LEDR, output wire [7:0] LEDG);
    // Asynchronous reset assertion; release takes two clock edges.
    (* ASYNC_REG = "TRUE" *) reg reset_meta, reset_sync;
    (* ASYNC_REG = "TRUE" *) reg mode_meta, mode_sync;
    reg echo_mode;
    reg [2:0] mode_settle;
    wire reset_n = reset_sync;
    always @(posedge CLOCK_50 or negedge RESET_N) begin
        if(!RESET_N) begin reset_meta<=0; reset_sync<=0; end
        else begin reset_meta<=1; reset_sync<=reset_meta; end
    end
    always @(posedge CLOCK_50 or negedge reset_n) begin
        if(!reset_n) begin mode_meta<=0; mode_sync<=0; echo_mode<=0; mode_settle<=0; end
        else begin
            mode_meta<=MODE; mode_sync<=mode_meta;
            if(mode_settle<4) mode_settle<=mode_settle+1'b1;
            if(mode_settle==3) echo_mode<=mode_sync;
        end
    end
    wire [7:0] rx_data;
    wire rx_valid, framing_error;
    uart_rx #(.CLOCK_HZ(CLOCK_HZ),.BAUD(BAUD)) receiver(
        CLOCK_50,reset_n,UART_RXD,rx_data,rx_valid,framing_error);
    wire [1:0] station_id;
    wire [15:0] sample_index;
    wire signed [15:0] sample_mhz;
    wire sample_valid, packet_error;
    // A framing failure aborts an incomplete parser transaction immediately.
    packet_parser #(.TIMEOUT_CLOCKS(CLOCK_HZ/50)) parser(
        CLOCK_50,reset_n && !framing_error,rx_data,rx_valid,
        station_id,sample_index,sample_mhz,sample_valid,packet_error);
    wire accepted, stream_error, overflow;
    station_demux router(CLOCK_50,reset_n,station_id,sample_index,sample_mhz,
        sample_valid,packet_error || framing_error || overflow,accepted,stream_error);
    wire result_valid, result_alarm;
    wire [1:0] result_station;
    wire [15:0] result_index;
    wire [54:0] result_energy;
    wire [3:0] alarms, published;
    wire detector_enable = !echo_mode && !stream_error && !packet_error && !framing_error && !overflow;
    correlator #(.ENERGY_THRESHOLD(ENERGY_THRESHOLD)) detector(
        CLOCK_50,reset_n,detector_enable,station_id,sample_index,sample_mhz,
        accepted,result_valid,result_station,result_index,result_energy,result_alarm,alarms,published);
    wire [7:0] tx_data;
    wire tx_valid, tx_ready, tx_busy;
    result_formatter formatter(CLOCK_50,reset_n,!stream_error && !packet_error && !framing_error && !overflow,
        echo_mode,sample_valid,station_id,sample_index,sample_mhz,
        result_valid,result_station,result_index,result_energy,result_alarm,tx_data,tx_valid,tx_ready,overflow);
    uart_tx #(.CLOCK_HZ(CLOCK_HZ),.BAUD(BAUD)) transmitter(
        CLOCK_50,reset_n,tx_data,tx_valid,tx_ready,UART_TXD,tx_busy);
    reg [31:0] rx_activity, tx_activity, heartbeat;
    always @(posedge CLOCK_50 or negedge reset_n) begin
        if(!reset_n) begin rx_activity<=0; tx_activity<=0; heartbeat<=0; end
        else begin
            if(sample_valid) rx_activity<=CLOCK_HZ/10;
            else if(rx_activity!=0) rx_activity<=rx_activity-1'b1;
            if(tx_busy) tx_activity<=CLOCK_HZ/10;
            else if(tx_activity!=0) tx_activity<=tx_activity-1'b1;
            if(heartbeat==CLOCK_HZ-1) heartbeat<=0; else heartbeat<=heartbeat+1'b1;
        end
    end
    assign LEDG = {heartbeat>=CLOCK_HZ/2,5'd0,tx_activity!=0,rx_activity!=0};
    assign LEDR = {(|published) && !stream_error,stream_error,alarms & {4{!stream_error}}};
endmodule
