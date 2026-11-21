`timescale 1ns/1ps
module uart_tx #(
    parameter CLOCK_HZ = 50000000,
    parameter BAUD = 115200
)(input wire clk, input wire reset_n, input wire [7:0] tx_data,
  input wire tx_valid, output wire tx_ready, output reg tx,
  output reg busy);
    localparam BIT_CLOCKS = (CLOCK_HZ + BAUD/2)/BAUD;
    reg [9:0] frame;
    reg [3:0] bit_index;
    reg [31:0] ticks;
    assign tx_ready = !busy;
    always @(posedge clk or negedge reset_n) begin
        if (!reset_n) begin tx <= 1; busy <= 0; frame <= 10'h3ff; bit_index <= 0; ticks <= 0; end
        else if (!busy) begin
            tx <= 1;
            if (tx_valid) begin
                frame <= {1'b1,tx_data,1'b0}; tx <= 0; busy <= 1;
                ticks <= BIT_CLOCKS-1; bit_index <= 0;
            end
        end else if (ticks != 0) ticks <= ticks-1;
        else if (bit_index == 9) begin busy <= 0; tx <= 1; end
        else begin
            bit_index <= bit_index+1'b1; tx <= frame[bit_index+1'b1]; ticks <= BIT_CLOCKS-1;
        end
    end
endmodule
