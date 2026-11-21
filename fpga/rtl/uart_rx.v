`timescale 1ns/1ps
// 8N1 receiver. All counters use system clocks; no generated clock.
module uart_rx #(
    parameter CLOCK_HZ = 50000000,
    parameter BAUD = 115200
)(input wire clk, input wire reset_n, input wire rx,
  output reg [7:0] rx_data, output reg rx_valid, output reg framing_error);
    localparam BIT_CLOCKS = (CLOCK_HZ + BAUD/2)/BAUD;
    (* ASYNC_REG = "TRUE" *) reg rx_meta, rx_sync;
    reg [2:0] state;
    reg [2:0] bit_index;
    reg [7:0] data;
    reg [31:0] ticks;
    always @(posedge clk or negedge reset_n)
        if (!reset_n) begin rx_meta <= 1'b1; rx_sync <= 1'b1; end
        else begin rx_meta <= rx; rx_sync <= rx_meta; end
    always @(posedge clk or negedge reset_n) begin
        if (!reset_n) begin
            state <= 0; ticks <= 0; bit_index <= 0; data <= 0;
            rx_data <= 0; rx_valid <= 0; framing_error <= 0;
        end else begin
            rx_valid <= 0; framing_error <= 0;
            case (state)
                0: if (!rx_sync) begin ticks <= BIT_CLOCKS/2-1; state <= 1; end
                1: if (ticks != 0) ticks <= ticks-1;
                   else if (rx_sync) state <= 0;
                   else begin ticks <= BIT_CLOCKS-1; bit_index <= 0; state <= 2; end
                2: if (ticks != 0) ticks <= ticks-1;
                   else begin
                       data[bit_index] <= rx_sync; ticks <= BIT_CLOCKS-1;
                       if (bit_index == 7) state <= 3;
                       else bit_index <= bit_index+1'b1;
                   end
                3: if (ticks != 0) ticks <= ticks-1;
                   else if (rx_sync) begin rx_data <= data; rx_valid <= 1; state <= 0; end
                   else begin framing_error <= 1; state <= 4; end
                // A bad stop bit must return high before a new start is accepted.
                4: if (rx_sync) state <= 0;
                default: state <= 0;
            endcase
        end
    end
endmodule
