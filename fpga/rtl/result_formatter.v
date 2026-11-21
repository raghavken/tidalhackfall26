`timescale 1ns/1ps
// Eight-entry packet FIFO plus an active serializer. No producer backpressure
// exists on the measurement wire: overflow is a fatal, latched replay error.
module result_formatter(
    input wire clk, input wire reset_n, input wire enable,
    input wire echo_mode, input wire echo_valid,
    input wire [1:0] echo_station, input wire [15:0] echo_index,
    input wire signed [15:0] echo_mhz,
    input wire result_valid, input wire [1:0] result_station,
    input wire [15:0] result_index, input wire [54:0] result_energy,
    input wire result_alarm,
    output wire [7:0] tx_data, output wire tx_valid,
    input wire tx_ready, output reg overflow
);
    reg [111:0] fifo [0:7];
    reg [3:0] lengths [0:7];
    reg [2:0] write_ptr, read_ptr;
    reg [3:0] count, bytes_left;
    reg [111:0] shift;
    reg [111:0] incoming;
    reg [7:0] checksum;
    integer j;
    wire push_request = echo_mode ? echo_valid : result_valid;
    wire pop = enable && bytes_left == 0 && count != 0;
    wire push = enable && push_request && (count < 8 || pop);
    assign tx_valid = enable && bytes_left != 0;
    assign tx_data = shift[7:0];
    always @* begin
        incoming = 0;
        if(echo_mode) begin
            incoming[7:0] = 8'haa; incoming[15:8] = {6'd0,echo_station};
            incoming[31:16] = echo_index; incoming[47:32] = echo_mhz;
            checksum = 0;
            for(j=0;j<6;j=j+1) checksum = checksum+incoming[j*8 +: 8];
            incoming[55:48] = checksum;
        end else begin
            incoming[7:0] = 8'h55; incoming[15:8] = {6'd0,result_station};
            incoming[31:16] = result_index; incoming[95:32] = {9'd0,result_energy};
            incoming[103:96] = {7'd0,result_alarm};
            checksum = 0;
            for(j=0;j<13;j=j+1) checksum = checksum+incoming[j*8 +: 8];
            incoming[111:104] = checksum;
        end
    end
    always @(posedge clk or negedge reset_n) begin
        if(!reset_n) begin
            write_ptr <= 0; read_ptr <= 0; count <= 0; bytes_left <= 0; shift <= 0; overflow <= 0;
        end else if(!enable) begin
            count <= 0; bytes_left <= 0; read_ptr <= 0; write_ptr <= 0;
        end else begin
            if(push_request && !push) overflow <= 1;
            if(push) begin
                fifo[write_ptr] <= incoming; lengths[write_ptr] <= echo_mode ? 7 : 14;
                write_ptr <= write_ptr+1'b1;
            end
            if(pop) begin
                shift <= fifo[read_ptr]; bytes_left <= lengths[read_ptr]; read_ptr <= read_ptr+1'b1;
            end else if(tx_valid && tx_ready) begin shift <= shift >> 8; bytes_left <= bytes_left-1'b1; end
            case({push,pop})
                2'b10: count <= count+1'b1;
                2'b01: count <= count-1'b1;
                default: count <= count;
            endcase
        end
    end
endmodule
