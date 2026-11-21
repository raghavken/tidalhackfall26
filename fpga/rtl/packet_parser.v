`timescale 1ns/1ps
module packet_parser #(
    parameter TIMEOUT_CLOCKS = 1000000
)(input wire clk, input wire reset_n,
  input wire [7:0] rx_data, input wire rx_valid,
  output reg [1:0] station_id, output reg [15:0] sample_index,
  output reg signed [15:0] sample_mhz,
  output reg sample_valid, output reg packet_error);
    reg [2:0] position;
    reg [7:0] sid, sum, index_low, index_high, value_low, value_high;
    reg [31:0] idle_clocks;
    always @(posedge clk or negedge reset_n) begin
        if (!reset_n) begin
            position <= 0; sid <= 0; sum <= 0; index_low <= 0; index_high <= 0;
            value_low <= 0; value_high <= 0; idle_clocks <= 0;
            station_id <= 0; sample_index <= 0; sample_mhz <= 0;
            sample_valid <= 0; packet_error <= 0;
        end else begin
            sample_valid <= 0; packet_error <= 0;
            if (rx_valid) begin
                idle_clocks <= 0;
                case(position)
                    0: if(rx_data == 8'haa) begin position <= 1; sum <= 8'haa; end
                    1: begin sid <= rx_data; sum <= sum+rx_data; position <= 2; end
                    2: begin index_low <= rx_data; sum <= sum+rx_data; position <= 3; end
                    3: begin index_high <= rx_data; sum <= sum+rx_data; position <= 4; end
                    4: begin value_low <= rx_data; sum <= sum+rx_data; position <= 5; end
                    5: begin value_high <= rx_data; sum <= sum+rx_data; position <= 6; end
                    6: begin
                        position <= 0;
                        if(sid < 4 && sum == rx_data) begin
                            station_id <= sid[1:0]; sample_index <= {index_high,index_low};
                            sample_mhz <= {value_high,value_low}; sample_valid <= 1;
                        end else packet_error <= 1;
                    end
                    default: position <= 0;
                endcase
            end else if(position != 0) begin
                if(idle_clocks == TIMEOUT_CLOCKS-1) begin
                    position <= 0; idle_clocks <= 0; packet_error <= 1;
                end else idle_clocks <= idle_clocks+1'b1;
            end
        end
    end
endmodule
